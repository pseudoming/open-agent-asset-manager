#include <node_api.h>

#include "native-errors.h"
#include "process-invocation.h"
#include "process-observation.h"
#include "safe-read.h"

#include <cmath>
#include <cstdint>
#include <exception>
#include <iterator>
#include <limits>
#include <memory>
#include <new>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace oaam::win32 {
namespace {

constexpr std::uint64_t kMaximumJavaScriptInteger = 9'007'199'254'740'991ULL;

void CheckNapi(const napi_env environment, const napi_status status, const char* message) {
    if (status == napi_ok) {
        return;
    }
    const napi_extended_error_info* information = nullptr;
    napi_get_last_error_info(environment, &information);
    const char* detail =
        information != nullptr && information->error_message != nullptr ? information->error_message : message;
    throw NativeFailure(FailureKind::io_error, "NAPI_FAILURE", detail);
}

[[nodiscard]] std::vector<napi_value> ReadArguments(
    const napi_env environment,
    const napi_callback_info callback_info,
    const std::size_t expected,
    const char* label,
    const bool allow_test_fault = false) {
    std::size_t argument_count = expected + (allow_test_fault ? 2U : 1U);
    std::vector<napi_value> arguments(argument_count);
    CheckNapi(
        environment,
        napi_get_cb_info(
            environment,
            callback_info,
            &argument_count,
            arguments.data(),
            nullptr,
            nullptr),
        "napi_get_cb_info failed");
    if (argument_count != expected &&
        (!allow_test_fault || argument_count != expected + 1U)) {
        ThrowInvalidPath(label);
    }
    arguments.resize(argument_count);
    return arguments;
}

[[nodiscard]] std::wstring ReadUtf16Argument(
    const napi_env environment,
    const napi_value value,
    const char* label) {
    napi_valuetype type = napi_undefined;
    CheckNapi(environment, napi_typeof(environment, value, &type), "napi_typeof failed");
    if (type != napi_string) {
        ThrowInvalidPath(label);
    }

    std::size_t length = 0;
    CheckNapi(
        environment,
        napi_get_value_string_utf16(environment, value, nullptr, 0, &length),
        "napi_get_value_string_utf16 length failed");
    std::vector<char16_t> buffer(length + 1U);
    std::size_t written = 0;
    CheckNapi(
        environment,
        napi_get_value_string_utf16(environment, value, buffer.data(), buffer.size(), &written),
        "napi_get_value_string_utf16 value failed");
    static_assert(sizeof(wchar_t) == sizeof(char16_t));
    return std::wstring(reinterpret_cast<const wchar_t*>(buffer.data()), written);
}

[[nodiscard]] std::string ReadUtf8Argument(
    const napi_env environment,
    const napi_value value,
    const char* label) {
    napi_valuetype type = napi_undefined;
    CheckNapi(environment, napi_typeof(environment, value, &type), "napi_typeof failed");
    if (type != napi_string) {
        ThrowInvalidPath(label);
    }

    std::size_t length = 0;
    CheckNapi(
        environment,
        napi_get_value_string_utf8(environment, value, nullptr, 0, &length),
        "napi_get_value_string_utf8 length failed");
    std::vector<char> buffer(length + 1U);
    std::size_t written = 0;
    CheckNapi(
        environment,
        napi_get_value_string_utf8(environment, value, buffer.data(), buffer.size(), &written),
        "napi_get_value_string_utf8 value failed");
    return std::string(buffer.data(), written);
}

[[nodiscard]] napi_value ReadNamedProperty(
    const napi_env environment,
    const napi_value object,
    const char* name) {
    napi_value value = nullptr;
    CheckNapi(
        environment,
        napi_get_named_property(environment, object, name, &value),
        "napi_get_named_property failed");
    return value;
}

[[nodiscard]] PhysicalIdentity ReadIdentityArgument(
    const napi_env environment,
    const napi_value value,
    const EntryKind expected_kind) {
    napi_valuetype type = napi_undefined;
    CheckNapi(environment, napi_typeof(environment, value, &type), "napi_typeof failed");
    bool is_array = false;
    CheckNapi(environment, napi_is_array(environment, value, &is_array), "napi_is_array failed");
    if (type != napi_object || is_array) {
        ThrowInvalidPath("expected physical identity must be one object");
    }
    const std::string device_id = ReadUtf8Argument(
        environment,
        ReadNamedProperty(environment, value, "deviceId"),
        "expected identity deviceId must be a string");
    const std::string file_id = ReadUtf8Argument(
        environment,
        ReadNamedProperty(environment, value, "fileId"),
        "expected identity fileId must be a string");
    const std::string entry_kind = ReadUtf8Argument(
        environment,
        ReadNamedProperty(environment, value, "entryKind"),
        "expected identity entryKind must be a string");
    const bool kind_matches =
        (expected_kind == EntryKind::file && entry_kind == "file") ||
        (expected_kind == EntryKind::directory && entry_kind == "directory");
    if (device_id.empty() || file_id.empty() || !kind_matches) {
        ThrowInvalidPath("expected physical identity is invalid");
    }
    return PhysicalIdentity{
        device_id,
        file_id,
        expected_kind,
    };
}

[[nodiscard]] NativeMutationFaultForTest ReadTestFaultArgument(
    const napi_env environment,
    const napi_value value) {
    const std::wstring fault = ReadUtf16Argument(
        environment,
        value,
        "native test fault must be one reviewed string");
    if (fault == L"replace_parent_before_publish") {
        return NativeMutationFaultForTest::replace_parent_before_publish;
    }
    if (fault == L"terminate_after_temp_flush") {
        return NativeMutationFaultForTest::terminate_after_temp_flush;
    }
    if (fault == L"terminate_after_publish") {
        return NativeMutationFaultForTest::terminate_after_publish;
    }
    if (fault == L"recycle_fixed_stage_success") {
        return NativeMutationFaultForTest::recycle_fixed_stage_success;
    }
    if (fault == L"recycle_fixed_stage_sharing_violation") {
        return NativeMutationFaultForTest::recycle_fixed_stage_sharing_violation;
    }
    if (fault == L"recycle_tree_fixed_stage_success") {
        return NativeMutationFaultForTest::recycle_tree_fixed_stage_success;
    }
    if (fault == L"recycle_tree_retry_first_operation_failure") {
        return NativeMutationFaultForTest::recycle_tree_retry_first_operation_failure;
    }
    if (fault == L"recycle_tree_hang_during_operation") {
        return NativeMutationFaultForTest::recycle_tree_hang_during_operation;
    }
    ThrowInvalidPath("native test fault is not part of the reviewed proof contract");
}

[[nodiscard]] std::uint64_t ReadLimitArgument(
    const napi_env environment,
    const napi_value value,
    const char* label) {
    napi_valuetype type = napi_undefined;
    CheckNapi(environment, napi_typeof(environment, value, &type), "napi_typeof failed");
    if (type != napi_number) {
        ThrowResourceLimit(label);
    }
    double numeric = 0;
    CheckNapi(environment, napi_get_value_double(environment, value, &numeric), "napi_get_value_double failed");
    if (!std::isfinite(numeric) || numeric < 0 || std::floor(numeric) != numeric ||
        numeric > static_cast<double>(kMaximumJavaScriptInteger)) {
        ThrowResourceLimit(label);
    }
    return static_cast<std::uint64_t>(numeric);
}

[[nodiscard]] std::vector<std::uint8_t> ReadBytesArgument(
    const napi_env environment,
    const napi_value value,
    const char* label) {
    bool is_buffer = false;
    CheckNapi(environment, napi_is_buffer(environment, value, &is_buffer), "napi_is_buffer failed");
    if (!is_buffer) {
        ThrowInvalidPath(label);
    }
    void* data = nullptr;
    std::size_t length = 0;
    CheckNapi(
        environment,
        napi_get_buffer_info(environment, value, &data, &length),
        "napi_get_buffer_info failed");
    if (length == 0) {
        return {};
    }
    const auto* first = static_cast<const std::uint8_t*>(data);
    return std::vector<std::uint8_t>(first, first + length);
}

class ScopedBytesZero final {
  public:
    explicit ScopedBytesZero(std::vector<std::uint8_t>& bytes) : bytes_(bytes) {}
    ~ScopedBytesZero() {
        if (!bytes_.empty()) {
            SecureZeroMemory(bytes_.data(), bytes_.size());
        }
    }
    ScopedBytesZero(const ScopedBytesZero&) = delete;
    ScopedBytesZero& operator=(const ScopedBytesZero&) = delete;

  private:
    std::vector<std::uint8_t>& bytes_;
};

[[nodiscard]] std::vector<std::wstring> ReadUtf16ArrayArgument(
    const napi_env environment,
    const napi_value value,
    const char* label) {
    bool is_array = false;
    CheckNapi(environment, napi_is_array(environment, value, &is_array), "napi_is_array failed");
    if (!is_array) {
        ThrowInvalidPath(label);
    }
    std::uint32_t length = 0;
    CheckNapi(environment, napi_get_array_length(environment, value, &length), "napi_get_array_length failed");
    std::vector<std::wstring> result;
    result.reserve(length);
    for (std::uint32_t index = 0; index < length; ++index) {
        napi_value item = nullptr;
        CheckNapi(environment, napi_get_element(environment, value, index, &item), "napi_get_element failed");
        result.push_back(ReadUtf16Argument(environment, item, label));
    }
    return result;
}

[[nodiscard]] std::vector<std::pair<std::wstring, std::wstring>>
ReadEnvironmentEntriesArgument(
    const napi_env environment,
    const napi_value value) {
    bool is_array = false;
    CheckNapi(environment, napi_is_array(environment, value, &is_array), "napi_is_array failed");
    if (!is_array) {
        ThrowInvalidPath("environmentEntries must be an array");
    }
    std::uint32_t length = 0;
    CheckNapi(environment, napi_get_array_length(environment, value, &length), "napi_get_array_length failed");
    std::vector<std::pair<std::wstring, std::wstring>> entries;
    entries.reserve(length);
    for (std::uint32_t index = 0; index < length; ++index) {
        napi_value item = nullptr;
        CheckNapi(environment, napi_get_element(environment, value, index, &item), "napi_get_element failed");
        entries.emplace_back(
            ReadUtf16Argument(
                environment,
                ReadNamedProperty(environment, item, "name"),
                "environment entry name must be a string"),
            ReadUtf16Argument(
                environment,
                ReadNamedProperty(environment, item, "value"),
                "environment entry value must be a string"));
    }
    return entries;
}

void SetNamedProperty(
    const napi_env environment,
    const napi_value object,
    const char* name,
    const napi_value value) {
    CheckNapi(
        environment,
        napi_set_named_property(environment, object, name, value),
        "napi_set_named_property failed");
}

[[nodiscard]] napi_value CreateUtf8(
    const napi_env environment,
    const std::string& value) {
    napi_value result = nullptr;
    CheckNapi(
        environment,
        napi_create_string_utf8(environment, value.data(), value.size(), &result),
        "napi_create_string_utf8 failed");
    return result;
}

[[nodiscard]] napi_value CreateUtf16(
    const napi_env environment,
    const std::wstring& value) {
    static_assert(sizeof(wchar_t) == sizeof(char16_t));
    napi_value result = nullptr;
    CheckNapi(
        environment,
        napi_create_string_utf16(
            environment,
            reinterpret_cast<const char16_t*>(value.data()),
            value.size(),
            &result),
        "napi_create_string_utf16 failed");
    return result;
}

[[nodiscard]] napi_value CreateBoolean(
    const napi_env environment,
    const bool value) {
    napi_value result = nullptr;
    CheckNapi(environment, napi_get_boolean(environment, value, &result), "napi_get_boolean failed");
    return result;
}

[[nodiscard]] napi_value CreateSafeInteger(
    const napi_env environment,
    const std::uint64_t value) {
    if (value > kMaximumJavaScriptInteger) {
        ThrowResourceLimit("native result exceeds JavaScript's exact integer range");
    }
    napi_value result = nullptr;
    CheckNapi(
        environment,
        napi_create_double(environment, static_cast<double>(value), &result),
        "napi_create_double failed");
    return result;
}

[[nodiscard]] napi_value CreateUndefined(const napi_env environment) {
    napi_value result = nullptr;
    CheckNapi(environment, napi_get_undefined(environment, &result), "napi_get_undefined failed");
    return result;
}

[[nodiscard]] napi_value CreateNull(const napi_env environment) {
    napi_value result = nullptr;
    CheckNapi(environment, napi_get_null(environment, &result), "napi_get_null failed");
    return result;
}

[[nodiscard]] napi_value CreateIdentity(
    const napi_env environment,
    const PhysicalIdentity& identity) {
    napi_value result = nullptr;
    CheckNapi(environment, napi_create_object(environment, &result), "napi_create_object failed");
    SetNamedProperty(environment, result, "deviceId", CreateUtf8(environment, identity.device_id));
    SetNamedProperty(environment, result, "fileId", CreateUtf8(environment, identity.file_id));
    SetNamedProperty(
        environment,
        result,
        "entryKind",
        CreateUtf8(environment, identity.entry_kind == EntryKind::file ? "file" : "directory"));
    return result;
}

[[nodiscard]] napi_value CreateReadResult(
    const napi_env environment,
    const StableRegularFileRead& result) {
    napi_value object = nullptr;
    CheckNapi(environment, napi_create_object(environment, &object), "napi_create_object failed");
    napi_value bytes = nullptr;
    CheckNapi(
        environment,
        napi_create_buffer_copy(
            environment,
            result.bytes.size(),
            result.bytes.empty() ? nullptr : result.bytes.data(),
            nullptr,
            &bytes),
        "napi_create_buffer_copy failed");
    SetNamedProperty(environment, object, "bytes", bytes);
    SetNamedProperty(environment, object, "executable", CreateBoolean(environment, result.executable));
    SetNamedProperty(environment, object, "identity", CreateIdentity(environment, result.identity));
    return object;
}

[[nodiscard]] napi_value CreateRangeReadResult(
    const napi_env environment,
    const StableRegularFileRangeRead& result) {
    napi_value object = nullptr;
    CheckNapi(environment, napi_create_object(environment, &object), "napi_create_object failed");
    napi_value bytes = nullptr;
    CheckNapi(
        environment,
        napi_create_buffer_copy(
            environment,
            result.bytes.size(),
            result.bytes.empty() ? nullptr : result.bytes.data(),
            nullptr,
            &bytes),
        "napi_create_buffer_copy failed");
    SetNamedProperty(environment, object, "bytes", bytes);
    SetNamedProperty(environment, object, "byteOffset", CreateSafeInteger(environment, result.byte_offset));
    SetNamedProperty(environment, object, "totalBytes", CreateSafeInteger(environment, result.total_bytes));
    SetNamedProperty(environment, object, "executable", CreateBoolean(environment, result.executable));
    SetNamedProperty(environment, object, "identity", CreateIdentity(environment, result.identity));
    return object;
}

[[nodiscard]] napi_value CreateInventoryResult(
    const napi_env environment,
    const StableDirectoryInventory& result) {
    napi_value object = nullptr;
    CheckNapi(environment, napi_create_object(environment, &object), "napi_create_object failed");
    SetNamedProperty(environment, object, "identity", CreateIdentity(environment, result.identity));

    napi_value entries = nullptr;
    CheckNapi(
        environment,
        napi_create_array_with_length(environment, result.entries.size(), &entries),
        "napi_create_array_with_length failed");
    for (std::size_t index = 0; index < result.entries.size(); ++index) {
        napi_value entry = nullptr;
        CheckNapi(environment, napi_create_object(environment, &entry), "napi_create_object failed");
        SetNamedProperty(
            environment,
            entry,
            "relativeName",
            CreateUtf16(environment, result.entries[index].relative_name));
        SetNamedProperty(
            environment,
            entry,
            "identity",
            CreateIdentity(environment, result.entries[index].identity));
        CheckNapi(
            environment,
            napi_set_element(environment, entries, static_cast<std::uint32_t>(index), entry),
            "napi_set_element failed");
    }
    SetNamedProperty(environment, object, "entries", entries);
    return object;
}

[[nodiscard]] napi_value CreateEnsuredDirectory(
    const napi_env environment,
    const EnsuredDirectory& result) {
    napi_value object = nullptr;
    CheckNapi(environment, napi_create_object(environment, &object), "napi_create_object failed");
    SetNamedProperty(environment, object, "identity", CreateIdentity(environment, result.identity));
    SetNamedProperty(environment, object, "created", CreateBoolean(environment, result.created));
    return object;
}

[[nodiscard]] napi_value CreateProcessIds(
    const napi_env environment,
    const std::vector<std::uint32_t>& process_ids) {
    napi_value result = nullptr;
    CheckNapi(
        environment,
        napi_create_array_with_length(
            environment,
            process_ids.size(),
            &result),
        "napi_create_array_with_length failed");
    for (std::size_t index = 0; index < process_ids.size(); ++index) {
        CheckNapi(
            environment,
            napi_set_element(
                environment,
                result,
                static_cast<std::uint32_t>(index),
                CreateSafeInteger(environment, process_ids[index])),
            "napi_set_element failed");
    }
    return result;
}

[[nodiscard]] napi_value CreateProcessObservation(
    const napi_env environment,
    const std::optional<NativeLocalProcessObservation>& observation) {
    if (!observation.has_value()) return CreateNull(environment);
    napi_value result = nullptr;
    CheckNapi(
        environment,
        napi_create_object(environment, &result),
        "napi_create_object failed");
    SetNamedProperty(
        environment,
        result,
        "processId",
        CreateSafeInteger(environment, observation->process_id));
    SetNamedProperty(
        environment,
        result,
        "lifecycleToken",
        CreateUtf8(environment, observation->lifecycle_token));
    SetNamedProperty(
        environment,
        result,
        "executableIdentity",
        CreateIdentity(environment, observation->executable_identity));
    napi_value bytes = nullptr;
    CheckNapi(
        environment,
        napi_create_buffer_copy(
            environment,
            observation->command_line_bytes.size(),
            observation->command_line_bytes.empty()
                ? nullptr
                : observation->command_line_bytes.data(),
            nullptr,
            &bytes),
        "napi_create_buffer_copy failed");
    SetNamedProperty(environment, result, "commandLineBytes", bytes);
    return result;
}

[[nodiscard]] napi_value CreateOwnedInvocationProcessIdentity(
    const napi_env environment,
    const NativeOwnedInvocationProcessIdentity& identity) {
    napi_value result = nullptr;
    CheckNapi(
        environment,
        napi_create_object(environment, &result),
        "napi_create_object failed");
    SetNamedProperty(
        environment,
        result,
        "processId",
        CreateSafeInteger(environment, identity.process_id));
    SetNamedProperty(
        environment,
        result,
        "lifecycleToken",
        CreateUtf8(environment, identity.lifecycle_token));
    return result;
}

[[nodiscard]] napi_value CreateBytes(
    const napi_env environment,
    const std::vector<std::uint8_t>& value) {
    napi_value result = nullptr;
    CheckNapi(
        environment,
        napi_create_buffer_copy(
            environment,
            value.size(),
            value.empty() ? nullptr : value.data(),
            nullptr,
            &result),
        "napi_create_buffer_copy failed");
    return result;
}

[[nodiscard]] napi_value CreateLocalExecutableTreeInvocationResult(
    const napi_env environment,
    const NativeLocalExecutableTreeInvocationResult& invocation) {
    napi_value result = nullptr;
    CheckNapi(
        environment,
        napi_create_object(environment, &result),
        "napi_create_object failed");
    SetNamedProperty(
        environment,
        result,
        "status",
        CreateUtf8(environment, invocation.status));
    SetNamedProperty(
        environment,
        result,
        "exitCode",
        invocation.exit_code.has_value()
            ? CreateSafeInteger(environment, *invocation.exit_code)
            : CreateNull(environment));
    SetNamedProperty(environment, result, "signal", CreateNull(environment));
    SetNamedProperty(
        environment,
        result,
        "stdout",
        CreateBytes(environment, invocation.stdout_bytes));
    SetNamedProperty(
        environment,
        result,
        "stderr",
        CreateBytes(environment, invocation.stderr_bytes));
    SetNamedProperty(
        environment,
        result,
        "rootProcess",
        CreateOwnedInvocationProcessIdentity(
            environment,
            invocation.root_process));
    napi_value observed = nullptr;
    CheckNapi(
        environment,
        napi_create_array_with_length(
            environment,
            invocation.observed_processes.size(),
            &observed),
        "napi_create_array_with_length failed");
    for (std::size_t index = 0;
         index < invocation.observed_processes.size();
         ++index) {
        CheckNapi(
            environment,
            napi_set_element(
                environment,
                observed,
                static_cast<std::uint32_t>(index),
                CreateOwnedInvocationProcessIdentity(
                    environment,
                    invocation.observed_processes[index])),
            "napi_set_element failed");
    }
    SetNamedProperty(environment, result, "observedProcesses", observed);
    SetNamedProperty(
        environment,
        result,
        "cleanupComplete",
        CreateBoolean(environment, invocation.cleanup_complete));
    SetNamedProperty(
        environment,
        result,
        "invocationTokenAbsent",
        CreateBoolean(environment, invocation.invocation_token_absent));
    SetNamedProperty(
        environment,
        result,
        "failureCode",
        CreateUtf8(environment, invocation.failure_code));
    return result;
}

void ThrowJavaScriptError(
    const napi_env environment,
    const FailureKind failure_kind,
    const std::string& system_code,
    const char* message,
    const std::optional<MutationState> mutation_state = std::nullopt) {
    napi_value message_value = nullptr;
    napi_value error = nullptr;
    if (napi_create_string_utf8(environment, message, NAPI_AUTO_LENGTH, &message_value) != napi_ok ||
        napi_create_error(environment, nullptr, message_value, &error) != napi_ok) {
        napi_throw_error(environment, "NAPI_FAILURE", message);
        return;
    }
    napi_value failure_kind_value = nullptr;
    napi_value system_code_value = nullptr;
    if (napi_create_string_utf8(
            environment,
            FailureKindName(failure_kind),
            NAPI_AUTO_LENGTH,
            &failure_kind_value) == napi_ok) {
        napi_set_named_property(environment, error, "failureKind", failure_kind_value);
    }
    if (napi_create_string_utf8(
            environment,
            system_code.c_str(),
            system_code.size(),
            &system_code_value) == napi_ok) {
        napi_set_named_property(environment, error, "systemCode", system_code_value);
    }
    if (mutation_state.has_value()) {
        napi_value mutation_state_value = nullptr;
        if (napi_create_string_utf8(
                environment,
                MutationStateName(*mutation_state),
                NAPI_AUTO_LENGTH,
                &mutation_state_value) == napi_ok) {
            napi_set_named_property(environment, error, "mutationState", mutation_state_value);
        }
    }
    napi_throw(environment, error);
}

template <typename Function>
[[nodiscard]] napi_value Invoke(
    const napi_env environment,
    Function&& function,
    const std::optional<MutationState>* default_mutation_state = nullptr) {
    const auto current_default_mutation_state = [&]() {
        return default_mutation_state == nullptr
                   ? std::optional<MutationState>{}
                   : *default_mutation_state;
    };
    try {
        return function();
    } catch (const NativeFailure& error) {
        ThrowJavaScriptError(
            environment,
            error.failure_kind(),
            error.system_code(),
            error.what(),
            error.mutation_state().has_value()
                ? error.mutation_state()
                : current_default_mutation_state());
    } catch (const std::bad_alloc&) {
        ThrowJavaScriptError(
            environment,
            FailureKind::resource_limit,
            "NATIVE_ALLOCATION_FAILED",
            "native filesystem allocation failed",
            current_default_mutation_state());
    } catch (const std::exception& error) {
        ThrowJavaScriptError(
            environment,
            FailureKind::io_error,
            "NATIVE_EXCEPTION",
            error.what(),
            current_default_mutation_state());
    } catch (...) {
        ThrowJavaScriptError(
            environment,
            FailureKind::io_error,
            "NATIVE_UNKNOWN_EXCEPTION",
            "native filesystem operation failed",
            current_default_mutation_state());
    }
    return nullptr;
}

[[nodiscard]] napi_value ReadRegularFileBinding(
    const napi_env environment,
    const napi_callback_info callback_info) {
    return Invoke(environment, [&]() {
        const std::vector<napi_value> arguments =
            ReadArguments(environment, callback_info, 2, "readRegularFile requires path and maximumBytes");
        const std::wstring path = ReadUtf16Argument(environment, arguments[0], "path must be a string");
        const std::uint64_t maximum_bytes =
            ReadLimitArgument(environment, arguments[1], "maximumBytes must be a non-negative safe integer");
        return CreateReadResult(environment, ReadRegularFileNoFollow(path, maximum_bytes));
    });
}

[[nodiscard]] napi_value ReadRegularFileRangeBinding(
    const napi_env environment,
    const napi_callback_info callback_info) {
    return Invoke(environment, [&]() {
        const std::vector<napi_value> arguments =
            ReadArguments(environment, callback_info, 3, "readRegularFileRange requires path, byteOffset and maximumBytes");
        const std::wstring path = ReadUtf16Argument(environment, arguments[0], "path must be a string");
        const std::uint64_t byte_offset =
            ReadLimitArgument(environment, arguments[1], "byteOffset must be a non-negative safe integer");
        const std::uint64_t maximum_bytes =
            ReadLimitArgument(environment, arguments[2], "maximumBytes must be a positive safe integer");
        if (maximum_bytes == 0) {
            ThrowResourceLimit("maximumBytes must be a positive safe integer");
        }
        return CreateRangeReadResult(
            environment,
            ReadRegularFileRangeNoFollow(path, byte_offset, maximum_bytes));
    });
}

[[nodiscard]] napi_value InspectRegularFileBinding(
    const napi_env environment,
    const napi_callback_info callback_info) {
    return Invoke(environment, [&]() {
        const std::vector<napi_value> arguments =
            ReadArguments(environment, callback_info, 1, "inspectRegularFile requires path");
        return CreateIdentity(
            environment,
            InspectRegularFileNoFollow(
                ReadUtf16Argument(environment, arguments[0], "path must be a string")));
    });
}

[[nodiscard]] napi_value InspectDirectoryBinding(
    const napi_env environment,
    const napi_callback_info callback_info) {
    return Invoke(environment, [&]() {
        const std::vector<napi_value> arguments =
            ReadArguments(environment, callback_info, 1, "inspectDirectory requires path");
        return CreateIdentity(
            environment,
            InspectDirectoryNoFollow(
                ReadUtf16Argument(environment, arguments[0], "path must be a string")));
    });
}

[[nodiscard]] napi_value InventoryDirectoryBinding(
    const napi_env environment,
    const napi_callback_info callback_info) {
    return Invoke(environment, [&]() {
        const std::vector<napi_value> arguments =
            ReadArguments(environment, callback_info, 2, "inventoryDirectory requires path and maximumEntries");
        const std::wstring path = ReadUtf16Argument(environment, arguments[0], "path must be a string");
        const std::uint64_t maximum_entries =
            ReadLimitArgument(environment, arguments[1], "maximumEntries must be a non-negative safe integer");
        return CreateInventoryResult(environment, InventoryDirectoryNoFollow(path, maximum_entries));
    });
}

[[nodiscard]] napi_value ListLocalProcessIdsBoundedBinding(
    const napi_env environment,
    const napi_callback_info callback_info) {
    return Invoke(environment, [&]() {
        const std::vector<napi_value> arguments =
            ReadArguments(
                environment,
                callback_info,
                1,
                "listLocalProcessIdsBounded requires maximumEntries");
        return CreateProcessIds(
            environment,
            ListLocalProcessIdsBounded(
                ReadLimitArgument(
                    environment,
                    arguments[0],
                    "maximumEntries must be a positive safe integer")));
    });
}

[[nodiscard]] napi_value ListLocalProcessExecutableCandidateIdsBoundedBinding(
    const napi_env environment,
    const napi_callback_info callback_info) {
    return Invoke(environment, [&]() {
        const std::vector<napi_value> arguments =
            ReadArguments(
                environment,
                callback_info,
                2,
                "listLocalProcessExecutableCandidateIdsBounded requires expected path and maximumEntries");
        return CreateProcessIds(
            environment,
            ListLocalProcessExecutableCandidateIdsBounded(
                ReadUtf16Argument(
                    environment,
                    arguments[0],
                    "expected executable path must be a string"),
                ReadLimitArgument(
                    environment,
                    arguments[1],
                    "maximumEntries must be a positive safe integer")));
    });
}

[[nodiscard]] napi_value ObserveLocalProcessBoundedBinding(
    const napi_env environment,
    const napi_callback_info callback_info) {
    return Invoke(environment, [&]() {
        const std::vector<napi_value> arguments =
            ReadArguments(
                environment,
                callback_info,
                3,
                "observeLocalProcessBounded requires processId, expected identity, and maximumCommandLineBytes");
        const std::uint64_t process_id =
            ReadLimitArgument(
                environment,
                arguments[0],
                "processId must be a positive safe integer");
        if (process_id == 0 ||
            process_id >
                static_cast<std::uint64_t>(
                    std::numeric_limits<std::uint32_t>::max())) {
            ThrowInvalidPath("processId is outside the Windows PID range");
        }
        return CreateProcessObservation(
            environment,
            ObserveLocalProcessBounded(
                static_cast<std::uint32_t>(process_id),
                std::nullopt,
                ReadIdentityArgument(
                    environment,
                    arguments[1],
                    EntryKind::file),
                ReadLimitArgument(
                    environment,
                    arguments[2],
                    "maximumCommandLineBytes must be a positive safe integer")));
    });
}

[[nodiscard]] napi_value ObserveLocalProcessExecutableBoundedBinding(
    const napi_env environment,
    const napi_callback_info callback_info) {
    return Invoke(environment, [&]() {
        const std::vector<napi_value> arguments =
            ReadArguments(
                environment,
                callback_info,
                4,
                "observeLocalProcessExecutableBounded requires processId, expected path, expected identity, and maximumCommandLineBytes");
        const std::uint64_t process_id =
            ReadLimitArgument(
                environment,
                arguments[0],
                "processId must be a positive safe integer");
        if (process_id == 0 ||
            process_id >
                static_cast<std::uint64_t>(
                    std::numeric_limits<std::uint32_t>::max())) {
            ThrowInvalidPath("processId is outside the Windows PID range");
        }
        return CreateProcessObservation(
            environment,
            ObserveLocalProcessBounded(
                static_cast<std::uint32_t>(process_id),
                ReadUtf16Argument(
                    environment,
                    arguments[1],
                    "expected executable path must be a string"),
                ReadIdentityArgument(
                    environment,
                    arguments[2],
                    EntryKind::file),
                ReadLimitArgument(
                    environment,
                    arguments[3],
                    "maximumCommandLineBytes must be a positive safe integer")));
    });
}

[[nodiscard]] napi_value InvokeLocalExecutableTreeBoundedBinding(
    const napi_env environment,
    const napi_callback_info callback_info) {
    return Invoke(environment, [&]() {
        const std::vector<napi_value> arguments =
            ReadArguments(
                environment,
                callback_info,
                8,
                "invokeLocalExecutableTreeBounded requires executable, identity, arguments, working directory, environment, token, timeout and output bound");
        const std::uint64_t timeout =
            ReadLimitArgument(
                environment,
                arguments[6],
                "timeoutMilliseconds must be a positive safe integer");
        if (timeout == 0 ||
            timeout > std::numeric_limits<std::uint32_t>::max()) {
            ThrowResourceLimit(
                "timeoutMilliseconds is outside the Windows timer range");
        }
        return CreateLocalExecutableTreeInvocationResult(
            environment,
            InvokeLocalExecutableTreeBounded(
                ReadUtf16Argument(
                    environment,
                    arguments[0],
                    "executablePath must be a string"),
                ReadIdentityArgument(
                    environment,
                    arguments[1],
                    EntryKind::file),
                ReadUtf16ArrayArgument(
                    environment,
                    arguments[2],
                    "arguments must be an array of strings"),
                ReadUtf16Argument(
                    environment,
                    arguments[3],
                    "workingDirectory must be a string"),
                ReadEnvironmentEntriesArgument(
                    environment,
                    arguments[4]),
                ReadUtf16Argument(
                    environment,
                    arguments[5],
                    "invocationToken must be a string"),
                static_cast<std::uint32_t>(timeout),
                ReadLimitArgument(
                    environment,
                    arguments[7],
                    "maximumOutputBytes must be a positive safe integer")));
    });
}

[[nodiscard]] napi_value ConfirmDurableRegularFileBinding(
    const napi_env environment,
    const napi_callback_info callback_info) {
    return Invoke(environment, [&]() {
        const std::vector<napi_value> arguments =
            ReadArguments(environment, callback_info, 1, "confirmDurableRegularFile requires path");
        return CreateReadResult(
            environment,
            ConfirmDurableRegularFileNoFollow(
                ReadUtf16Argument(environment, arguments[0], "path must be a string")));
    });
}

[[nodiscard]] napi_value ConfirmDurableDirectoryBinding(
    const napi_env environment,
    const napi_callback_info callback_info) {
    return Invoke(environment, [&]() {
        const std::vector<napi_value> arguments =
            ReadArguments(environment, callback_info, 1, "confirmDurableDirectory requires path");
        return CreateIdentity(
            environment,
            ConfirmDurableDirectoryNoFollow(
                ReadUtf16Argument(environment, arguments[0], "path must be a string")));
    });
}

[[nodiscard]] napi_value ConfirmDurableDirectoryTreeBinding(
    const napi_env environment,
    const napi_callback_info callback_info) {
    return Invoke(environment, [&]() {
        const std::vector<napi_value> arguments =
            ReadArguments(environment, callback_info, 2, "confirmDurableDirectoryTree requires path and maximumEntries");
        const std::wstring path = ReadUtf16Argument(environment, arguments[0], "path must be a string");
        const std::uint64_t maximum_entries =
            ReadLimitArgument(environment, arguments[1], "maximumEntries must be a non-negative safe integer");
        return CreateIdentity(
            environment,
            ConfirmDurableDirectoryTreeNoFollow(path, maximum_entries));
    });
}

[[nodiscard]] napi_value EnsureDirectoryBinding(
    const napi_env environment,
    const napi_callback_info callback_info) {
    std::optional<MutationState> binding_mutation_state =
        MutationState::not_applied;
    return Invoke(
        environment,
        [&]() {
            const std::vector<napi_value> arguments =
                ReadArguments(environment, callback_info, 2, "ensureDirectory requires parentPath and childName");
            const EnsuredDirectory result =
                DurableEnsureDirectory(
                    ReadUtf16Argument(environment, arguments[0], "parentPath must be a string"),
                    ReadUtf16Argument(environment, arguments[1], "childName must be a string"));
            binding_mutation_state =
                result.created
                    ? MutationState::may_have_applied
                    : MutationState::not_applied;
            return CreateEnsuredDirectory(
                environment,
                result);
        },
        &binding_mutation_state);
}

[[nodiscard]] napi_value ReplaceFileBinding(
    const napi_env environment,
    const napi_callback_info callback_info) {
    std::optional<MutationState> binding_mutation_state =
        MutationState::not_applied;
    return Invoke(
        environment,
        [&]() {
            const std::vector<napi_value> arguments =
                ReadArguments(
                    environment,
                    callback_info,
                    2,
                    "replaceFile requires path, bytes, and at most one private test fault",
                    true);
            const NativeMutationFaultForTest test_fault =
                arguments.size() == 3U
                    ? ReadTestFaultArgument(environment, arguments[2])
                    : NativeMutationFaultForTest::none;
            const PhysicalIdentity result =
                DurableReplaceFile(
                    ReadUtf16Argument(environment, arguments[0], "path must be a string"),
                    ReadBytesArgument(environment, arguments[1], "bytes must be a Buffer"),
                    test_fault);
            binding_mutation_state = MutationState::may_have_applied;
            return CreateIdentity(
                environment,
                result);
        },
        &binding_mutation_state);
}

[[nodiscard]] napi_value CreateFileBinding(
    const napi_env environment,
    const napi_callback_info callback_info) {
    std::optional<MutationState> binding_mutation_state =
        MutationState::not_applied;
    return Invoke(
        environment,
        [&]() {
            const std::vector<napi_value> arguments =
                ReadArguments(
                    environment,
                    callback_info,
                    2,
                    "createFile requires path and bytes");
            const PhysicalIdentity result =
                DurableCreateFile(
                    ReadUtf16Argument(environment, arguments[0], "path must be a string"),
                    ReadBytesArgument(environment, arguments[1], "bytes must be a Buffer"));
            binding_mutation_state = MutationState::may_have_applied;
            return CreateIdentity(
                environment,
                result);
        },
        &binding_mutation_state);
}

[[nodiscard]] napi_value RemoveRegularFileBinding(
    const napi_env environment,
    const napi_callback_info callback_info) {
    std::optional<MutationState> binding_mutation_state =
        MutationState::not_applied;
    return Invoke(
        environment,
        [&]() {
            const std::vector<napi_value> arguments =
                ReadArguments(
                    environment,
                    callback_info,
                    1,
                    "removeRegularFile requires path and at most one private test fault",
                    true);
            const NativeMutationFaultForTest test_fault =
                arguments.size() == 2U
                    ? ReadTestFaultArgument(environment, arguments[1])
                    : NativeMutationFaultForTest::none;
            const bool result =
                DurableRemoveRegularFile(
                    ReadUtf16Argument(environment, arguments[0], "path must be a string"),
                    test_fault);
            binding_mutation_state =
                result
                    ? MutationState::may_have_applied
                    : MutationState::not_applied;
            return CreateBoolean(
                environment,
                result);
        },
        &binding_mutation_state);
}

[[nodiscard]] napi_value RecycleRegularFileIfIdentityBinding(
    const napi_env environment,
    const napi_callback_info callback_info) {
    std::optional<MutationState> binding_mutation_state =
        MutationState::not_applied;
    return Invoke(
        environment,
        [&]() {
            const std::vector<napi_value> arguments =
                ReadArguments(
                    environment,
                    callback_info,
                    2,
                    "recycleRegularFileIfIdentity requires path and expected identity");
            const bool result =
                DurableRecycleRegularFileIfIdentity(
                    ReadUtf16Argument(environment, arguments[0], "path must be a string"),
                    ReadIdentityArgument(environment, arguments[1], EntryKind::file));
            binding_mutation_state =
                result
                    ? MutationState::may_have_applied
                    : MutationState::not_applied;
            return CreateBoolean(
                environment,
                result);
        },
        &binding_mutation_state);
}

[[nodiscard]] napi_value PermanentlyRemoveRegularFileIfIdentityBinding(
    const napi_env environment,
    const napi_callback_info callback_info) {
    std::optional<MutationState> binding_mutation_state =
        MutationState::not_applied;
    return Invoke(
        environment,
        [&]() {
            const std::vector<napi_value> arguments =
                ReadArguments(
                    environment,
                    callback_info,
                    2,
                    "permanentlyRemoveRegularFileIfIdentity requires path and expected identity");
            const bool result =
                PermanentlyRemoveRegularFileIfIdentity(
                    ReadUtf16Argument(environment, arguments[0], "path must be a string"),
                    ReadIdentityArgument(environment, arguments[1], EntryKind::file));
            binding_mutation_state =
                result
                    ? MutationState::may_have_applied
                    : MutationState::not_applied;
            return CreateBoolean(
                environment,
                result);
        },
        &binding_mutation_state);
}

[[nodiscard]] napi_value RecycleDirectoryTreeIfIdentityBinding(
    const napi_env environment,
    const napi_callback_info callback_info) {
    std::optional<MutationState> binding_mutation_state =
        MutationState::not_applied;
    return Invoke(
        environment,
        [&]() {
            const std::vector<napi_value> arguments =
                ReadArguments(
                    environment,
                    callback_info,
                    3,
                    "recycleDirectoryTreeIfIdentity requires path, expected identity, and maximumEntries");
            const bool result =
                DurableRecycleDirectoryTreeIfIdentity(
                    ReadUtf16Argument(environment, arguments[0], "path must be a string"),
                    ReadIdentityArgument(environment, arguments[1], EntryKind::directory),
                    ReadLimitArgument(
                        environment,
                        arguments[2],
                        "maximumEntries must be a non-negative safe integer"));
            binding_mutation_state =
                result
                    ? MutationState::may_have_applied
                    : MutationState::not_applied;
            return CreateBoolean(
                environment,
                result);
        },
        &binding_mutation_state);
}

[[nodiscard]] napi_value RemoveDirectoryTreeBinding(
    const napi_env environment,
    const napi_callback_info callback_info) {
    std::optional<MutationState> binding_mutation_state =
        MutationState::not_applied;
    return Invoke(
        environment,
        [&]() {
            const std::vector<napi_value> arguments =
                ReadArguments(
                    environment,
                    callback_info,
                    2,
                    "removeDirectoryTree requires path, maximumEntries, and at most one private test fault",
                    true);
            const std::wstring path =
                ReadUtf16Argument(environment, arguments[0], "path must be a string");
            const std::uint64_t maximum_entries =
                ReadLimitArgument(environment, arguments[1], "maximumEntries must be a non-negative safe integer");
            const NativeMutationFaultForTest test_fault =
                arguments.size() == 3U
                    ? ReadTestFaultArgument(environment, arguments[2])
                    : NativeMutationFaultForTest::none;
            const bool result =
                DurableRemoveDirectoryTree(
                    path,
                    maximum_entries,
                    test_fault);
            binding_mutation_state =
                result
                    ? MutationState::may_have_applied
                    : MutationState::not_applied;
            return CreateBoolean(
                environment,
                result);
        },
        &binding_mutation_state);
}

[[nodiscard]] napi_value PublishFileBinding(const napi_env environment, const napi_callback_info callback_info) {
    std::optional<MutationState> binding_mutation_state = MutationState::not_applied;
    return Invoke(environment, [&]() {
        const std::vector<napi_value> arguments = ReadArguments(environment, callback_info, 3,
            "publishFile requires sourcePath, targetParentPath, and targetName");
        const PhysicalIdentity result = DurablePublishFile(
            ReadUtf16Argument(environment, arguments[0], "sourcePath must be a string"),
            ReadUtf16Argument(environment, arguments[1], "targetParentPath must be a string"),
            ReadUtf16Argument(environment, arguments[2], "targetName must be a string"));
        binding_mutation_state = MutationState::may_have_applied;
        return CreateIdentity(environment, result);
    }, &binding_mutation_state);
}

[[nodiscard]] napi_value PublishDirectoryBinding(
    const napi_env environment,
    const napi_callback_info callback_info) {
    std::optional<MutationState> binding_mutation_state =
        MutationState::not_applied;
    return Invoke(
        environment,
        [&]() {
            const std::vector<napi_value> arguments =
                ReadArguments(
                    environment,
                    callback_info,
                    4,
                    "publishDirectory requires stagedPath, targetParentPath, targetName, and maximumEntries");
            const PhysicalIdentity result =
                DurablePublishDirectory(
                    ReadUtf16Argument(environment, arguments[0], "stagedPath must be a string"),
                    ReadUtf16Argument(environment, arguments[1], "targetParentPath must be a string"),
                    ReadUtf16Argument(environment, arguments[2], "targetName must be a string"),
                    ReadLimitArgument(
                        environment,
                        arguments[3],
                        "maximumEntries must be a non-negative safe integer"));
            binding_mutation_state = MutationState::may_have_applied;
            return CreateIdentity(
                environment,
                result);
        },
        &binding_mutation_state);
}

void FinalizeLockLease(napi_env, void* data, void*) {
    LockLeaseDeleter{}(static_cast<LockLease*>(data));
}

[[nodiscard]] napi_value AcquireLockBinding(
    const napi_env environment,
    const napi_callback_info callback_info) {
    return Invoke(environment, [&]() {
        const std::vector<napi_value> arguments =
            ReadArguments(environment, callback_info, 1, "acquireLock requires path");
        LockLeaseOwner lease = AcquirePersistentLock(
            ReadUtf16Argument(environment, arguments[0], "path must be a string"));
        if (!lease) {
            return CreateNull(environment);
        }
        napi_value result = nullptr;
        const napi_status status =
            napi_create_external(environment, lease.get(), FinalizeLockLease, nullptr, &result);
        CheckNapi(environment, status, "napi_create_external failed");
        static_cast<void>(lease.release());
        return result;
    });
}

[[nodiscard]] napi_value ReleaseLockBinding(
    const napi_env environment,
    const napi_callback_info callback_info) {
    return Invoke(environment, [&]() {
        const std::vector<napi_value> arguments =
            ReadArguments(environment, callback_info, 1, "releaseLock requires a lock token");
        void* data = nullptr;
        CheckNapi(
            environment,
            napi_get_value_external(environment, arguments[0], &data),
            "lock token must be the native external returned by acquireLock");
        if (data == nullptr) {
            throw NativeFailure(
                FailureKind::io_error,
                "NATIVE_LOCK_TOKEN_INVALID",
                "lock token does not contain a native lease");
        }
        ReleasePersistentLock(*static_cast<LockLease*>(data));
        return CreateUndefined(environment);
    });
}

}  // namespace
}  // namespace oaam::win32

NAPI_MODULE_INIT() {
    napi_property_descriptor properties[] = {
        {"readRegularFile", nullptr, oaam::win32::ReadRegularFileBinding, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"readRegularFileRange", nullptr, oaam::win32::ReadRegularFileRangeBinding, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"inspectRegularFile", nullptr, oaam::win32::InspectRegularFileBinding, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"inspectDirectory", nullptr, oaam::win32::InspectDirectoryBinding, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"inventoryDirectory", nullptr, oaam::win32::InventoryDirectoryBinding, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"listLocalProcessExecutableCandidateIdsBounded", nullptr, oaam::win32::ListLocalProcessExecutableCandidateIdsBoundedBinding, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"listLocalProcessIdsBounded", nullptr, oaam::win32::ListLocalProcessIdsBoundedBinding, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"observeLocalProcessBounded", nullptr, oaam::win32::ObserveLocalProcessBoundedBinding, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"observeLocalProcessExecutableBounded", nullptr, oaam::win32::ObserveLocalProcessExecutableBoundedBinding, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"invokeLocalExecutableTreeBounded", nullptr, oaam::win32::InvokeLocalExecutableTreeBoundedBinding, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"confirmDurableRegularFile", nullptr, oaam::win32::ConfirmDurableRegularFileBinding, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"confirmDurableDirectory", nullptr, oaam::win32::ConfirmDurableDirectoryBinding, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"confirmDurableDirectoryTree", nullptr, oaam::win32::ConfirmDurableDirectoryTreeBinding, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"ensureDirectory", nullptr, oaam::win32::EnsureDirectoryBinding, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"createFile", nullptr, oaam::win32::CreateFileBinding, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"replaceFile", nullptr, oaam::win32::ReplaceFileBinding, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"removeRegularFile", nullptr, oaam::win32::RemoveRegularFileBinding, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"permanentlyRemoveRegularFileIfIdentity", nullptr, oaam::win32::PermanentlyRemoveRegularFileIfIdentityBinding, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"recycleRegularFileIfIdentity", nullptr, oaam::win32::RecycleRegularFileIfIdentityBinding, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"recycleDirectoryTreeIfIdentity", nullptr, oaam::win32::RecycleDirectoryTreeIfIdentityBinding, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"removeDirectoryTree", nullptr, oaam::win32::RemoveDirectoryTreeBinding, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"publishFile", nullptr, oaam::win32::PublishFileBinding, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"publishDirectory", nullptr, oaam::win32::PublishDirectoryBinding, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"acquireLock", nullptr, oaam::win32::AcquireLockBinding, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"releaseLock", nullptr, oaam::win32::ReleaseLockBinding, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    if (napi_define_properties(env, exports, std::size(properties), properties) != napi_ok) {
        napi_throw_error(env, "NAPI_FAILURE", "could not define OAAM Windows filesystem exports");
        return nullptr;
    }
    napi_value contract = nullptr;
    if (napi_create_string_utf8(
            env,
            "oaam.win32.filesystem.v15",
            NAPI_AUTO_LENGTH,
            &contract) != napi_ok ||
        napi_set_named_property(env, exports, "contractVersion", contract) != napi_ok) {
        napi_throw_error(env, "NAPI_FAILURE", "could not define OAAM Windows filesystem contract");
        return nullptr;
    }
    return exports;
}
