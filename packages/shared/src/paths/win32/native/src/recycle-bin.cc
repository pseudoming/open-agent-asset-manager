#include "safe-read.h"

#include "native-errors.h"

#include <shellapi.h>
#include <shlobj.h>
#include <shobjidl.h>

#include <array>
#include <cstdio>
#include <string>

namespace oaam::win32::detail {
namespace {

constexpr DWORD kRecycleFlags =
    FOF_NO_UI |
    FOF_NO_CONNECTED_ELEMENTS |
    FOFX_RECYCLEONDELETE |
    FOFX_EARLYFAILURE |
    FOFX_NOCOPYHOOKS;

constexpr std::array<DWORD, 2> kRecycleRetryDelaysMilliseconds = {50, 150};

template <typename Interface>
class ComPointer final {
  public:
    ComPointer() noexcept = default;
    ~ComPointer() {
        reset();
    }

    ComPointer(const ComPointer&) = delete;
    ComPointer& operator=(const ComPointer&) = delete;

    [[nodiscard]] Interface* get() const noexcept {
        return value_;
    }

    [[nodiscard]] Interface** put() noexcept {
        reset();
        return &value_;
    }

    void reset() noexcept {
        if (value_ != nullptr) {
            value_->Release();
            value_ = nullptr;
        }
    }

  private:
    Interface* value_ = nullptr;
};

class ComApartment final {
  public:
    ComApartment() {
        const HRESULT result = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
        if (FAILED(result)) {
            throw NativeFailure(
                FailureKind::io_error,
                HresultCode(result),
                "CoInitializeEx could not establish the Recycle Bin apartment");
        }
        initialized_ = true;
    }

    ~ComApartment() {
        if (initialized_) {
            CoUninitialize();
        }
    }

    ComApartment(const ComApartment&) = delete;
    ComApartment& operator=(const ComApartment&) = delete;

  private:
    [[nodiscard]] static std::string HresultCode(const HRESULT result) {
        std::array<char, 32> buffer{};
        std::snprintf(
            buffer.data(),
            buffer.size(),
            "HRESULT_%08lX",
            static_cast<unsigned long>(result));
        return std::string(buffer.data());
    }

    bool initialized_ = false;
};

[[nodiscard]] std::string HresultCode(const HRESULT result) {
    std::array<char, 32> buffer{};
    std::snprintf(
        buffer.data(),
        buffer.size(),
        "HRESULT_%08lX",
        static_cast<unsigned long>(result));
    return std::string(buffer.data());
}

[[noreturn]] void ThrowHresult(const HRESULT result, const char* message) {
    if (HRESULT_FACILITY(result) == FACILITY_WIN32) {
        ThrowWin32(HRESULT_CODE(result), message);
    }
    throw NativeFailure(FailureKind::io_error, HresultCode(result), message);
}

struct RecycleAttemptResult {
    HRESULT perform_result;
    BOOL aborted;
};

[[nodiscard]] RecycleAttemptResult PerformRecycleAttempt(
    const std::wstring& staged_path,
    const bool fail_for_test,
    const bool hang_for_test) {
    ComPointer<IFileOperation> operation;
    HRESULT result = CoCreateInstance(
        CLSID_FileOperation,
        nullptr,
        CLSCTX_INPROC_SERVER,
        IID_PPV_ARGS(operation.put()));
    if (FAILED(result)) {
        ThrowHresult(result, "CoCreateInstance(IFileOperation) failed");
    }
    result = operation.get()->SetOperationFlags(kRecycleFlags);
    if (FAILED(result)) {
        ThrowHresult(result, "IFileOperation::SetOperationFlags failed");
    }

    ComPointer<IShellItem> item;
    result = SHCreateItemFromParsingName(
        staged_path.c_str(),
        nullptr,
        IID_PPV_ARGS(item.put()));
    if (FAILED(result)) {
        ThrowHresult(result, "SHCreateItemFromParsingName failed");
    }
    result = operation.get()->DeleteItem(item.get(), nullptr);
    if (FAILED(result)) {
        ThrowHresult(result, "IFileOperation::DeleteItem failed");
    }
    if (fail_for_test) {
        return RecycleAttemptResult{HRESULT_FROM_WIN32(ERROR_BUSY), FALSE};
    }
    if (hang_for_test) {
        Sleep(INFINITE);
    }
    result = operation.get()->PerformOperations();
    if (FAILED(result)) {
        return RecycleAttemptResult{result, FALSE};
    }
    BOOL aborted = FALSE;
    result = operation.get()->GetAnyOperationsAborted(&aborted);
    if (FAILED(result)) {
        ThrowHresult(result, "IFileOperation::GetAnyOperationsAborted failed");
    }
    return RecycleAttemptResult{S_OK, aborted};
}

void RequireExactStagedIdentityForRetry(
    const std::wstring& staged_path,
    const HANDLE held_entry,
    const PhysicalIdentity& expected_identity,
    const HRESULT failed_result) {
    const StableSample held_sample = QueryStableSample(held_entry);
    if (!SameIdentity(held_sample.identity, expected_identity)) {
        ThrowStale("Recycle Bin retry found a changed held physical identity");
    }
    try {
        UniqueHandle reopened = OpenCanonicalPath(
            staged_path,
            expected_identity.entry_kind);
        const StableSample path_sample = QueryStableSample(reopened.get());
        if (!SameIdentity(path_sample.identity, expected_identity)) {
            ThrowStale("Recycle Bin retry found a different staged path identity");
        }
    } catch (const NativeFailure& error) {
        if (error.failure_kind() != FailureKind::not_found) {
            throw;
        }
        ThrowHresult(
            failed_result,
            "IFileOperation::PerformOperations failed and the exact staged path is absent");
    }
}

[[nodiscard]] bool PathIsAbsent(const std::wstring& path) {
    const DWORD attributes = GetFileAttributesW(path.c_str());
    if (attributes != INVALID_FILE_ATTRIBUTES) {
        return false;
    }
    const DWORD error = GetLastError();
    if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) {
        return true;
    }
    ThrowWin32(error, "GetFileAttributesW could not verify Recycle Bin source absence");
}

}  // namespace

void RecycleStagedEntry(
    const std::wstring& staged_path,
    const HANDLE held_entry,
    const PhysicalIdentity& expected_identity,
    const bool fail_first_operation_for_test,
    const bool hang_during_operation_for_test) {
    const StableSample before = QueryStableSample(held_entry);
    if (!SameIdentity(before.identity, expected_identity)) {
        ThrowStale("Recycle Bin staging identity changed before handoff");
    }

    ComApartment apartment;
    BOOL aborted = FALSE;
    for (std::size_t attempt = 0;
         attempt <= kRecycleRetryDelaysMilliseconds.size();
         ++attempt) {
        const RecycleAttemptResult result = PerformRecycleAttempt(
            staged_path,
            fail_first_operation_for_test && attempt == 0,
            hang_during_operation_for_test && attempt == 0);
        if (SUCCEEDED(result.perform_result)) {
            aborted = result.aborted;
            break;
        }
        if (attempt == kRecycleRetryDelaysMilliseconds.size()) {
            ThrowHresult(
                result.perform_result,
                "IFileOperation::PerformOperations failed after bounded exact-identity retries");
        }
        RequireExactStagedIdentityForRetry(
            staged_path,
            held_entry,
            expected_identity,
            result.perform_result);
        Sleep(kRecycleRetryDelaysMilliseconds[attempt]);
        RequireExactStagedIdentityForRetry(
            staged_path,
            held_entry,
            expected_identity,
            result.perform_result);
    }

    const StableSample after = QueryStableSample(held_entry);
    if (!SameIdentity(after.identity, expected_identity)) {
        ThrowStale("Recycle Bin handoff changed the held physical identity");
    }
    if (aborted != FALSE || !PathIsAbsent(staged_path)) {
        throw NativeFailure(
            FailureKind::io_error,
            aborted != FALSE ? "WINDOWS_RECYCLE_ABORTED" : "WINDOWS_RECYCLE_SOURCE_REMAINS",
            "Recycle Bin handoff did not remove the exact staged path");
    }
}

}  // namespace oaam::win32::detail
