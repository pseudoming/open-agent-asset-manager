#pragma once

#ifndef _WIN32
#error "OAAM's Windows process observer may only be built for Windows."
#endif

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "safe-read.h"

namespace oaam::win32 {

struct NativeLocalProcessObservation {
    std::uint32_t process_id;
    std::string lifecycle_token;
    PhysicalIdentity executable_identity;
    std::vector<std::uint8_t> command_line_bytes;
};

[[nodiscard]] std::vector<std::uint32_t> ListLocalProcessIdsBounded(
    std::uint64_t maximum_entries);

[[nodiscard]] std::vector<std::uint32_t>
ListLocalProcessExecutableCandidateIdsBounded(
    const std::wstring& expected_executable_path,
    std::uint64_t maximum_entries);

[[nodiscard]] std::optional<NativeLocalProcessObservation> ObserveLocalProcessBounded(
    std::uint32_t process_id,
    const std::optional<std::wstring>& expected_executable_path,
    const PhysicalIdentity& expected_executable_identity,
    std::uint64_t maximum_command_line_bytes);

}  // namespace oaam::win32
