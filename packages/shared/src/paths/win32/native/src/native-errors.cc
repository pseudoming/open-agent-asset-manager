#include "native-errors.h"

#include <array>
#include <cstdio>
#include <utility>

namespace oaam::win32 {
namespace {

constexpr NTSTATUS kStatusReparsePointEncountered = static_cast<NTSTATUS>(0xC000050BL);
constexpr NTSTATUS kStatusFileIsADirectory = static_cast<NTSTATUS>(0xC00000BAL);
constexpr NTSTATUS kStatusNotADirectory = static_cast<NTSTATUS>(0xC0000103L);

[[nodiscard]] FailureKind FailureKindFromWin32(const DWORD error) noexcept {
    switch (error) {
        case ERROR_FILE_NOT_FOUND:
        case ERROR_PATH_NOT_FOUND:
            return FailureKind::not_found;
        case ERROR_BAD_PATHNAME:
        case ERROR_FILENAME_EXCED_RANGE:
        case ERROR_INVALID_NAME:
            return FailureKind::invalid_path;
        case ERROR_ACCESS_DENIED:
        case ERROR_PRIVILEGE_NOT_HELD:
        case ERROR_SHARING_VIOLATION:
        case ERROR_LOCK_VIOLATION:
            return FailureKind::permission_denied;
        case ERROR_CANT_ACCESS_FILE:
        case ERROR_REPARSE_POINT_ENCOUNTERED:
        case ERROR_REPARSE_TAG_INVALID:
        case ERROR_REPARSE_TAG_MISMATCH:
        case ERROR_STOPPED_ON_SYMLINK:
            return FailureKind::symlink_or_reparse;
        case ERROR_DIRECTORY:
            return FailureKind::wrong_entry_type;
        case ERROR_NOT_ENOUGH_MEMORY:
        case ERROR_OUTOFMEMORY:
        case ERROR_TOO_MANY_OPEN_FILES:
            return FailureKind::resource_limit;
        case ERROR_NOT_SUPPORTED:
        case ERROR_INVALID_FUNCTION:
        case ERROR_FILE_OFFLINE:
        case ERROR_INVALID_DRIVE:
        case ERROR_NOT_READY:
        case ERROR_UNRECOGNIZED_VOLUME:
        case ERROR_CLOUD_FILE_NETWORK_UNAVAILABLE:
        case ERROR_CLOUD_FILE_NOT_SUPPORTED:
        case ERROR_CLOUD_FILE_PROVIDER_NOT_RUNNING:
            return FailureKind::unsupported_platform;
        default:
            return FailureKind::io_error;
    }
}

[[nodiscard]] std::string DecimalSystemCode(const DWORD error) {
    return "WIN32_" + std::to_string(error);
}

[[nodiscard]] std::string NtSystemCode(const NTSTATUS status) {
    std::array<char, 32> buffer{};
    std::snprintf(buffer.data(), buffer.size(), "NTSTATUS_%08lX", static_cast<unsigned long>(status));
    return std::string(buffer.data());
}

}  // namespace

NativeFailure::NativeFailure(
    FailureKind failure_kind,
    std::string system_code,
    std::string message,
    std::optional<MutationState> mutation_state)
    : std::runtime_error(std::move(message)),
      failure_kind_(failure_kind),
      system_code_(std::move(system_code)),
      mutation_state_(mutation_state) {}

FailureKind NativeFailure::failure_kind() const noexcept {
    return failure_kind_;
}

const std::string& NativeFailure::system_code() const noexcept {
    return system_code_;
}

const std::optional<MutationState>& NativeFailure::mutation_state() const noexcept {
    return mutation_state_;
}

const char* FailureKindName(const FailureKind failure_kind) noexcept {
    switch (failure_kind) {
        case FailureKind::invalid_path:
            return "invalid_path";
        case FailureKind::not_found:
            return "not_found";
        case FailureKind::permission_denied:
            return "permission_denied";
        case FailureKind::symlink_or_reparse:
            return "symlink_or_reparse";
        case FailureKind::wrong_entry_type:
            return "wrong_entry_type";
        case FailureKind::resource_limit:
            return "resource_limit";
        case FailureKind::stale:
            return "stale";
        case FailureKind::unsupported_platform:
            return "unsupported_platform";
        case FailureKind::io_error:
            return "io_error";
    }
    return "io_error";
}

const char* MutationStateName(const MutationState mutation_state) noexcept {
    switch (mutation_state) {
        case MutationState::not_applied:
            return "not_applied";
        case MutationState::may_have_applied:
            return "may_have_applied";
    }
    return "may_have_applied";
}

void ThrowInvalidPath(const char* message) {
    throw NativeFailure(FailureKind::invalid_path, "INVALID_PATH", message);
}

void ThrowResourceLimit(const char* message) {
    throw NativeFailure(FailureKind::resource_limit, "RESOURCE_LIMIT", message);
}

void ThrowStale(const char* message) {
    throw NativeFailure(FailureKind::stale, "STALE_SAMPLE", message);
}

void ThrowWrongEntryType(const char* message) {
    throw NativeFailure(FailureKind::wrong_entry_type, "WRONG_ENTRY_TYPE", message);
}

void ThrowReparse(const char* message, std::string system_code) {
    throw NativeFailure(FailureKind::symlink_or_reparse, std::move(system_code), message);
}

void ThrowWin32(const DWORD error, const char* message) {
    throw NativeFailure(FailureKindFromWin32(error), DecimalSystemCode(error), message);
}

void ThrowNtStatus(const NTSTATUS status, const char* message) {
    if (status == kStatusReparsePointEncountered) {
        ThrowReparse(message, NtSystemCode(status));
    }
    if (status == kStatusFileIsADirectory || status == kStatusNotADirectory) {
        throw NativeFailure(FailureKind::wrong_entry_type, NtSystemCode(status), message);
    }

    using RtlNtStatusToDosErrorFunction = ULONG(WINAPI*)(NTSTATUS);
    const HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    if (ntdll == nullptr) {
        throw NativeFailure(FailureKind::io_error, NtSystemCode(status), message);
    }
    const auto conversion = reinterpret_cast<RtlNtStatusToDosErrorFunction>(
        GetProcAddress(ntdll, "RtlNtStatusToDosError"));
    if (conversion == nullptr) {
        throw NativeFailure(FailureKind::io_error, NtSystemCode(status), message);
    }
    const DWORD error = conversion(status);
    throw NativeFailure(FailureKindFromWin32(error), NtSystemCode(status) + "/" + DecimalSystemCode(error), message);
}

}  // namespace oaam::win32
