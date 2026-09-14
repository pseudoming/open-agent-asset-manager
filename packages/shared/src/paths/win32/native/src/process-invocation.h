#pragma once

#ifndef _WIN32
#error "OAAM's Windows process invoker may only be built for Windows."
#endif

#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "safe-read.h"

namespace oaam::win32 {

struct NativeOwnedInvocationProcessIdentity {
    std::uint32_t process_id;
    std::string lifecycle_token;
};

struct NativeLocalExecutableTreeInvocationResult {
    std::string status;
    std::optional<std::uint32_t> exit_code;
    std::vector<std::uint8_t> stdout_bytes;
    std::vector<std::uint8_t> stderr_bytes;
    NativeOwnedInvocationProcessIdentity root_process;
    std::vector<NativeOwnedInvocationProcessIdentity> observed_processes;
    bool cleanup_complete;
    bool invocation_token_absent;
    std::string failure_code;
};

[[nodiscard]] NativeLocalExecutableTreeInvocationResult
InvokeLocalExecutableTreeBounded(
    const std::wstring& executable_path,
    const PhysicalIdentity& expected_executable_identity,
    const std::vector<std::wstring>& arguments,
    const std::wstring& working_directory,
    const std::vector<std::pair<std::wstring, std::wstring>>& environment_entries,
    const std::wstring& invocation_token,
    std::uint32_t timeout_milliseconds,
    std::uint64_t maximum_output_bytes);

}  // namespace oaam::win32
