#pragma once

#ifndef _WIN32
#error "OAAM's Windows filesystem addon may only be built for Windows."
#endif

#include <windows.h>
#include <winternl.h>

#include <optional>
#include <stdexcept>
#include <string>

namespace oaam::win32 {

enum class FailureKind {
    invalid_path,
    not_found,
    permission_denied,
    symlink_or_reparse,
    wrong_entry_type,
    resource_limit,
    stale,
    unsupported_platform,
    io_error,
};

enum class MutationState {
    not_applied,
    may_have_applied,
};

class NativeFailure final : public std::runtime_error {
  public:
    NativeFailure(
        FailureKind failure_kind,
        std::string system_code,
        std::string message,
        std::optional<MutationState> mutation_state = std::nullopt);

    [[nodiscard]] FailureKind failure_kind() const noexcept;
    [[nodiscard]] const std::string& system_code() const noexcept;
    [[nodiscard]] const std::optional<MutationState>& mutation_state() const noexcept;

  private:
    FailureKind failure_kind_;
    std::string system_code_;
    std::optional<MutationState> mutation_state_;
};

[[nodiscard]] const char* FailureKindName(FailureKind failure_kind) noexcept;
[[nodiscard]] const char* MutationStateName(MutationState mutation_state) noexcept;

[[noreturn]] void ThrowInvalidPath(const char* message);
[[noreturn]] void ThrowResourceLimit(const char* message);
[[noreturn]] void ThrowStale(const char* message);
[[noreturn]] void ThrowWrongEntryType(const char* message);
[[noreturn]] void ThrowReparse(const char* message, std::string system_code = "WIN32_REPARSE");
[[noreturn]] void ThrowWin32(DWORD error, const char* message);
[[noreturn]] void ThrowNtStatus(NTSTATUS status, const char* message);

}  // namespace oaam::win32
