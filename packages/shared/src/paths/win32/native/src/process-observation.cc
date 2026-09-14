#include "process-observation.h"

#include <tlhelp32.h>

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace oaam::win32 {
namespace {

constexpr std::size_t kMaximumProcessImagePathCharacters = 32'768U;
constexpr ULONG kMaximumProcessCommandLineResultBytes = 131'072U;
constexpr PROCESSINFOCLASS kProcessCommandLineInformation =
    static_cast<PROCESSINFOCLASS>(60);
constexpr NTSTATUS kStatusInfoLengthMismatch =
    static_cast<NTSTATUS>(0xC0000004L);
constexpr NTSTATUS kStatusInvalidInfoClass =
    static_cast<NTSTATUS>(0xC0000003L);

using NtQueryInformationProcessFunction = NTSTATUS(NTAPI*)(
    HANDLE,
    PROCESSINFOCLASS,
    PVOID,
    ULONG,
    PULONG);

struct ProcessSample {
    std::uint64_t creation_time;
    std::wstring image_path;
    PhysicalIdentity image_identity;
};

[[noreturn]] void ThrowProcessNotFound(const char* message) {
    throw NativeFailure(
        FailureKind::not_found,
        "WIN32_PROCESS_NOT_FOUND",
        message);
}

[[nodiscard]] bool EqualOrdinalIgnoreCase(
    const std::wstring& left,
    const std::wstring& right) {
    if (left.size() > static_cast<std::size_t>(std::numeric_limits<int>::max()) ||
        right.size() > static_cast<std::size_t>(std::numeric_limits<int>::max())) {
        ThrowResourceLimit("Windows process path exceeds the comparison limit");
    }
    return CompareStringOrdinal(
               left.data(),
               static_cast<int>(left.size()),
               right.data(),
               static_cast<int>(right.size()),
               TRUE) == CSTR_EQUAL;
}

[[nodiscard]] std::wstring BasenameOfCanonicalLocalPath(
    const std::wstring& path) {
    const detail::ParsedPath parsed = detail::ParseCanonicalLocalPath(path);
    if (parsed.segments.empty()) {
        ThrowInvalidPath("expected process executable path must identify one file");
    }
    return parsed.segments.back();
}

[[nodiscard]] std::optional<std::wstring> SnapshotImageName(
    const std::uint32_t process_id) {
    detail::UniqueHandle snapshot(
        CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
    if (!snapshot.valid()) {
        const DWORD error = GetLastError();
        if (error == ERROR_BAD_LENGTH) {
            ThrowStale("Windows process snapshot changed while it was created");
        }
        ThrowWin32(error, "could not create a bounded Windows process snapshot");
    }

    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    if (Process32FirstW(snapshot.get(), &entry) == FALSE) {
        const DWORD error = GetLastError();
        if (error == ERROR_NO_MORE_FILES) return std::nullopt;
        ThrowWin32(error, "could not read the first Windows process snapshot entry");
    }
    do {
        if (entry.th32ProcessID == process_id) {
            return std::wstring(entry.szExeFile);
        }
        entry.dwSize = sizeof(entry);
    } while (Process32NextW(snapshot.get(), &entry) != FALSE);

    const DWORD error = GetLastError();
    if (error != ERROR_NO_MORE_FILES) {
        ThrowWin32(error, "could not continue the Windows process snapshot");
    }
    return std::nullopt;
}

[[nodiscard]] std::uint64_t FileTimeValue(const FILETIME& value) noexcept {
    return (static_cast<std::uint64_t>(value.dwHighDateTime) << 32U) |
           static_cast<std::uint64_t>(value.dwLowDateTime);
}

[[nodiscard]] std::uint64_t QueryCreationTime(HANDLE process) {
    FILETIME creation{};
    FILETIME exit{};
    FILETIME kernel{};
    FILETIME user{};
    if (GetProcessTimes(process, &creation, &exit, &kernel, &user) == FALSE) {
        ThrowWin32(GetLastError(), "could not query the Windows process lifecycle");
    }
    return FileTimeValue(creation);
}

[[nodiscard]] std::wstring QueryProcessImagePath(HANDLE process) {
    std::vector<wchar_t> buffer(kMaximumProcessImagePathCharacters);
    DWORD characters = static_cast<DWORD>(buffer.size());
    if (QueryFullProcessImageNameW(process, 0, buffer.data(), &characters) == FALSE) {
        ThrowWin32(GetLastError(), "could not query the Windows process executable path");
    }
    if (characters == 0 || characters >= buffer.size()) {
        ThrowResourceLimit("Windows process executable path is empty or exceeds the reviewed limit");
    }
    std::wstring result(buffer.data(), characters);
    static_cast<void>(detail::ParseCanonicalLocalPath(result));
    return result;
}

[[nodiscard]] PhysicalIdentity InspectProcessImagePath(
    const std::wstring& image_path) {
    detail::UniqueHandle image =
        detail::OpenCanonicalPath(image_path, EntryKind::file);
    return detail::QueryStableSample(image.get()).identity;
}

[[nodiscard]] ProcessSample SampleProcess(HANDLE process) {
    const std::uint64_t creation_time = QueryCreationTime(process);
    const std::wstring image_path = QueryProcessImagePath(process);
    const PhysicalIdentity image_identity = InspectProcessImagePath(image_path);
    return ProcessSample{
        creation_time,
        image_path,
        image_identity,
    };
}

[[nodiscard]] NtQueryInformationProcessFunction ResolveProcessQuery() {
    const HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    if (ntdll == nullptr) {
        throw NativeFailure(
            FailureKind::unsupported_platform,
            "WIN32_NTDLL_UNAVAILABLE",
            "Windows process command-line query is unavailable");
    }
    const FARPROC address =
        GetProcAddress(ntdll, "NtQueryInformationProcess");
    if (address == nullptr) {
        throw NativeFailure(
            FailureKind::unsupported_platform,
            "WIN32_PROCESS_QUERY_UNAVAILABLE",
            "Windows process command-line query is unavailable");
    }
    return reinterpret_cast<NtQueryInformationProcessFunction>(address);
}

[[nodiscard]] std::wstring QueryProcessCommandLine(HANDLE process) {
    const NtQueryInformationProcessFunction query = ResolveProcessQuery();
    ULONG required = 0;
    const NTSTATUS first_status = query(
        process,
        kProcessCommandLineInformation,
        nullptr,
        0,
        &required);
    if (first_status == kStatusInvalidInfoClass) {
        throw NativeFailure(
            FailureKind::unsupported_platform,
            "WIN32_PROCESS_COMMAND_LINE_UNAVAILABLE",
            "Windows does not expose the reviewed process command-line query");
    }
    if (first_status != kStatusInfoLengthMismatch || required < sizeof(UNICODE_STRING)) {
        if (first_status < 0) {
            ThrowNtStatus(
                first_status,
                "could not determine the Windows process command-line size");
        }
        throw NativeFailure(
            FailureKind::io_error,
            "WIN32_PROCESS_COMMAND_LINE_INVALID",
            "Windows returned an invalid process command-line size");
    }
    if (required > kMaximumProcessCommandLineResultBytes) {
        ThrowResourceLimit("Windows process command line exceeds the native query limit");
    }

    const std::size_t aligned_words =
        (static_cast<std::size_t>(required) + sizeof(std::uint64_t) - 1U) /
        sizeof(std::uint64_t);
    std::vector<std::uint64_t> storage(aligned_words);
    ULONG written = 0;
    const NTSTATUS status = query(
        process,
        kProcessCommandLineInformation,
        storage.data(),
        static_cast<ULONG>(storage.size() * sizeof(std::uint64_t)),
        &written);
    if (status < 0) {
        ThrowNtStatus(status, "could not read the Windows process command line");
    }
    if (written < sizeof(UNICODE_STRING) ||
        written > storage.size() * sizeof(std::uint64_t)) {
        throw NativeFailure(
            FailureKind::io_error,
            "WIN32_PROCESS_COMMAND_LINE_INVALID",
            "Windows returned an invalid process command-line result size");
    }

    const auto* value =
        reinterpret_cast<const UNICODE_STRING*>(storage.data());
    if (value->Length > value->MaximumLength ||
        value->Length % sizeof(wchar_t) != 0) {
        throw NativeFailure(
            FailureKind::io_error,
            "WIN32_PROCESS_COMMAND_LINE_INVALID",
            "Windows returned an invalid process command-line string");
    }
    if (value->Length == 0) return {};
    if (value->Buffer == nullptr) {
        throw NativeFailure(
            FailureKind::io_error,
            "WIN32_PROCESS_COMMAND_LINE_INVALID",
            "Windows returned a missing process command-line buffer");
    }

    const auto storage_begin =
        reinterpret_cast<std::uintptr_t>(storage.data());
    const auto storage_end =
        storage_begin + storage.size() * sizeof(std::uint64_t);
    const auto string_begin =
        reinterpret_cast<std::uintptr_t>(value->Buffer);
    const auto string_end = string_begin + value->Length;
    if (string_begin < storage_begin ||
        string_end < string_begin ||
        string_end > storage_end) {
        throw NativeFailure(
            FailureKind::io_error,
            "WIN32_PROCESS_COMMAND_LINE_INVALID",
            "Windows process command-line buffer escaped its result storage");
    }
    return std::wstring(
        value->Buffer,
        value->Length / sizeof(wchar_t));
}

[[nodiscard]] std::vector<std::wstring> ParseCommandLine(
    const std::wstring& command_line) {
    std::vector<std::wstring> arguments;
    std::size_t cursor = 0;
    while (cursor < command_line.size()) {
        while (cursor < command_line.size() &&
               (command_line[cursor] == L' ' ||
                command_line[cursor] == L'\t')) {
            cursor += 1U;
        }
        if (cursor == command_line.size()) break;

        std::wstring argument;
        bool quoted = false;
        while (cursor < command_line.size()) {
            std::size_t backslashes = 0;
            while (cursor < command_line.size() &&
                   command_line[cursor] == L'\\') {
                backslashes += 1U;
                cursor += 1U;
            }
            if (cursor < command_line.size() &&
                command_line[cursor] == L'"') {
                argument.append(backslashes / 2U, L'\\');
                if (backslashes % 2U != 0) {
                    argument.push_back(L'"');
                    cursor += 1U;
                    continue;
                }
                if (quoted &&
                    cursor + 1U < command_line.size() &&
                    command_line[cursor + 1U] == L'"') {
                    argument.push_back(L'"');
                    cursor += 2U;
                    continue;
                }
                quoted = !quoted;
                cursor += 1U;
                continue;
            }
            argument.append(backslashes, L'\\');
            if (cursor == command_line.size() ||
                (!quoted &&
                 (command_line[cursor] == L' ' ||
                  command_line[cursor] == L'\t'))) {
                break;
            }
            argument.push_back(command_line[cursor]);
            cursor += 1U;
        }
        if (quoted) {
            throw NativeFailure(
                FailureKind::io_error,
                "WIN32_PROCESS_COMMAND_LINE_AMBIGUOUS",
                "Windows process command line has an unmatched quote");
        }
        arguments.push_back(std::move(argument));
    }
    return arguments;
}

[[nodiscard]] std::vector<std::uint8_t> EncodeArguments(
    const std::vector<std::wstring>& arguments,
    const std::uint64_t maximum_bytes) {
    std::vector<std::uint8_t> result;
    for (const std::wstring& argument : arguments) {
        if (argument.size() >
            static_cast<std::size_t>(std::numeric_limits<int>::max())) {
            ThrowResourceLimit("Windows process argument exceeds the conversion limit");
        }
        const int required = WideCharToMultiByte(
            CP_UTF8,
            WC_ERR_INVALID_CHARS,
            argument.data(),
            static_cast<int>(argument.size()),
            nullptr,
            0,
            nullptr,
            nullptr);
        if (required == 0 && !argument.empty()) {
            ThrowWin32(
                GetLastError(),
                "could not size a Windows process argument");
        }
        const std::uint64_t next_size =
            static_cast<std::uint64_t>(result.size()) +
            static_cast<std::uint64_t>(required) + 1U;
        if (next_size > maximum_bytes) {
            ThrowResourceLimit(
                "Windows process command line exceeds the caller's byte limit");
        }
        const std::size_t offset = result.size();
        result.resize(static_cast<std::size_t>(next_size));
        if (required > 0) {
            const int written = WideCharToMultiByte(
                CP_UTF8,
                WC_ERR_INVALID_CHARS,
                argument.data(),
                static_cast<int>(argument.size()),
                reinterpret_cast<char*>(result.data() + offset),
                required,
                nullptr,
                nullptr);
            if (written != required) {
                ThrowWin32(
                    GetLastError(),
                    "could not encode a Windows process argument");
            }
        }
        result.back() = 0;
    }
    return result;
}

[[nodiscard]] bool SameProcessSample(
    const ProcessSample& left,
    const ProcessSample& right) {
    return left.creation_time == right.creation_time &&
           EqualOrdinalIgnoreCase(left.image_path, right.image_path) &&
           detail::SameIdentity(left.image_identity, right.image_identity);
}

}  // namespace

std::vector<std::uint32_t> ListLocalProcessIdsBounded(
    const std::uint64_t maximum_entries) {
    if (maximum_entries == 0 ||
        maximum_entries >
            static_cast<std::uint64_t>(
                std::numeric_limits<std::uint32_t>::max())) {
        ThrowResourceLimit(
            "maximum process entries must be one bounded positive integer");
    }
    detail::UniqueHandle snapshot(
        CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
    if (!snapshot.valid()) {
        const DWORD error = GetLastError();
        if (error == ERROR_BAD_LENGTH) {
            ThrowStale("Windows process snapshot changed while it was created");
        }
        ThrowWin32(error, "could not create a bounded Windows process snapshot");
    }

    std::vector<std::uint32_t> process_ids;
    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    if (Process32FirstW(snapshot.get(), &entry) == FALSE) {
        const DWORD error = GetLastError();
        if (error == ERROR_NO_MORE_FILES) return process_ids;
        ThrowWin32(error, "could not read the first Windows process snapshot entry");
    }
    do {
        if (entry.th32ProcessID != 0) {
            if (process_ids.size() >= maximum_entries) {
                ThrowResourceLimit(
                    "Windows process snapshot exceeds the caller's entry limit");
            }
            process_ids.push_back(entry.th32ProcessID);
        }
        entry.dwSize = sizeof(entry);
    } while (Process32NextW(snapshot.get(), &entry) != FALSE);

    const DWORD error = GetLastError();
    if (error != ERROR_NO_MORE_FILES) {
        ThrowWin32(error, "could not continue the Windows process snapshot");
    }
    std::sort(process_ids.begin(), process_ids.end());
    const auto duplicate =
        std::adjacent_find(process_ids.begin(), process_ids.end());
    if (duplicate != process_ids.end()) {
        ThrowStale("Windows process snapshot contains a duplicate PID");
    }
    return process_ids;
}

std::vector<std::uint32_t>
ListLocalProcessExecutableCandidateIdsBounded(
    const std::wstring& expected_executable_path,
    const std::uint64_t maximum_entries) {
    if (maximum_entries == 0 ||
        maximum_entries >
            static_cast<std::uint64_t>(
                std::numeric_limits<std::uint32_t>::max())) {
        ThrowResourceLimit(
            "maximum process entries must be one bounded positive integer");
    }
    const std::wstring expected_basename =
        BasenameOfCanonicalLocalPath(expected_executable_path);
    detail::UniqueHandle snapshot(
        CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
    if (!snapshot.valid()) {
        const DWORD error = GetLastError();
        if (error == ERROR_BAD_LENGTH) {
            ThrowStale("Windows process snapshot changed while it was created");
        }
        ThrowWin32(error, "could not create a bounded Windows process snapshot");
    }

    std::uint64_t observed_entries = 0;
    std::vector<std::uint32_t> candidate_ids;
    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    if (Process32FirstW(snapshot.get(), &entry) == FALSE) {
        const DWORD error = GetLastError();
        if (error == ERROR_NO_MORE_FILES) return candidate_ids;
        ThrowWin32(error, "could not read the first Windows process snapshot entry");
    }
    do {
        if (entry.th32ProcessID != 0) {
            ++observed_entries;
            if (observed_entries > maximum_entries) {
                ThrowResourceLimit(
                    "Windows process snapshot exceeds the caller's entry limit");
            }
            if (EqualOrdinalIgnoreCase(
                    std::wstring(entry.szExeFile),
                    expected_basename)) {
                candidate_ids.push_back(entry.th32ProcessID);
            }
        }
        entry.dwSize = sizeof(entry);
    } while (Process32NextW(snapshot.get(), &entry) != FALSE);

    const DWORD error = GetLastError();
    if (error != ERROR_NO_MORE_FILES) {
        ThrowWin32(error, "could not continue the Windows process snapshot");
    }
    std::sort(candidate_ids.begin(), candidate_ids.end());
    const auto duplicate =
        std::adjacent_find(candidate_ids.begin(), candidate_ids.end());
    if (duplicate != candidate_ids.end()) {
        ThrowStale("Windows process snapshot contains a duplicate PID");
    }
    return candidate_ids;
}

std::optional<NativeLocalProcessObservation> ObserveLocalProcessBounded(
    const std::uint32_t process_id,
    const std::optional<std::wstring>& expected_executable_path,
    const PhysicalIdentity& expected_executable_identity,
    const std::uint64_t maximum_command_line_bytes) {
    if (process_id == 0) {
        ThrowInvalidPath("processId must be one positive Windows PID");
    }
    if (maximum_command_line_bytes == 0) {
        ThrowResourceLimit(
            "maximumCommandLineBytes must be one positive integer");
    }

    if (expected_executable_path.has_value()) {
        const std::optional<std::wstring> snapshot_name =
            SnapshotImageName(process_id);
        if (!snapshot_name.has_value()) {
            ThrowProcessNotFound(
                "Windows process disappeared before it could be observed");
        }
        if (!EqualOrdinalIgnoreCase(
                *snapshot_name,
                BasenameOfCanonicalLocalPath(*expected_executable_path))) {
            return std::nullopt;
        }
    }

    detail::UniqueHandle process(
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION,
            FALSE,
            process_id));
    if (!process.valid()) {
        const DWORD error = GetLastError();
        if (error == ERROR_INVALID_PARAMETER) {
            ThrowProcessNotFound(
                "Windows process disappeared before it could be opened");
        }
        ThrowWin32(error, "could not open the Windows process for observation");
    }
    if (GetProcessId(process.get()) != process_id) {
        ThrowStale("Windows process handle does not match the requested PID");
    }

    const ProcessSample before = SampleProcess(process.get());
    if (expected_executable_path.has_value() &&
        !EqualOrdinalIgnoreCase(
            before.image_path,
            *expected_executable_path)) {
        return std::nullopt;
    }
    if (!detail::SameIdentity(
            before.image_identity,
            expected_executable_identity)) {
        return std::nullopt;
    }

    const std::vector<std::uint8_t> command_line_bytes =
        EncodeArguments(
            ParseCommandLine(QueryProcessCommandLine(process.get())),
            maximum_command_line_bytes);
    const ProcessSample after = SampleProcess(process.get());
    if (!SameProcessSample(before, after) ||
        !detail::SameIdentity(
            after.image_identity,
            expected_executable_identity) ||
        (expected_executable_path.has_value() &&
         !EqualOrdinalIgnoreCase(
             after.image_path,
             *expected_executable_path))) {
        ThrowStale("Windows process identity changed while it was observed");
    }

    return NativeLocalProcessObservation{
        process_id,
        std::to_string(after.creation_time),
        after.image_identity,
        command_line_bytes,
    };
}

}  // namespace oaam::win32
