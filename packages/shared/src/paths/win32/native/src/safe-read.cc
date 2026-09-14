#include "safe-read.h"

#include "native-errors.h"

#include <windows.h>
#include <winternl.h>

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace oaam::win32 {
namespace detail {

constexpr ULONG kObjectCaseInsensitive = 0x00000040UL;
constexpr ULONG kObjectDontReparse = 0x00001000UL;
constexpr ULONG kFileOpen = 0x00000001UL;
constexpr ULONG kFileDirectoryFile = 0x00000001UL;
constexpr ULONG kFileWriteThrough = 0x00000002UL;
constexpr ULONG kFileSynchronousIoNonAlert = 0x00000020UL;
constexpr ULONG kFileNonDirectoryFile = 0x00000040UL;
constexpr ULONG kFileOpenReparsePoint = 0x00200000UL;
constexpr ULONG_PTR kFileCreated = 0x00000002UL;
constexpr FILE_INFORMATION_CLASS kFileRenameInformationClass = static_cast<FILE_INFORMATION_CLASS>(10);
constexpr std::size_t kDirectoryBufferBytes = 64U * 1024U;
constexpr std::uint64_t kMaximumJavaScriptInteger = 9'007'199'254'740'991ULL;

using NtCreateFileFunction = NTSTATUS(NTAPI*)(
    PHANDLE,
    ACCESS_MASK,
    POBJECT_ATTRIBUTES,
    PIO_STATUS_BLOCK,
    PLARGE_INTEGER,
    ULONG,
    ULONG,
    ULONG,
    ULONG,
    PVOID,
    ULONG);

using NtSetInformationFileFunction = NTSTATUS(NTAPI*)(
    HANDLE,
    PIO_STATUS_BLOCK,
    PVOID,
    ULONG,
    FILE_INFORMATION_CLASS);

struct RelativeRenameInformation {
    BOOLEAN replace_if_exists;
    std::array<std::byte, 7> alignment;
    HANDLE root_directory;
    ULONG file_name_length;
    WCHAR file_name[1];
};

static_assert(offsetof(RelativeRenameInformation, file_name) == 20);

UniqueHandle::UniqueHandle(const HANDLE value) noexcept : value_(value) {}

UniqueHandle::~UniqueHandle() {
    reset();
}

UniqueHandle::UniqueHandle(UniqueHandle&& other) noexcept : value_(other.release()) {}

UniqueHandle& UniqueHandle::operator=(UniqueHandle&& other) noexcept {
    if (this != &other) {
        reset(other.release());
    }
    return *this;
}

HANDLE UniqueHandle::get() const noexcept {
    return value_;
}

bool UniqueHandle::valid() const noexcept {
    return value_ != nullptr && value_ != INVALID_HANDLE_VALUE;
}

HANDLE UniqueHandle::release() noexcept {
    const HANDLE result = value_;
    value_ = INVALID_HANDLE_VALUE;
    return result;
}

void UniqueHandle::reset(const HANDLE replacement) noexcept {
    if (valid()) {
        CloseHandle(value_);
    }
    value_ = replacement;
}

[[nodiscard]] bool IsAsciiDriveLetter(const wchar_t value) noexcept {
    return (value >= L'A' && value <= L'Z') || (value >= L'a' && value <= L'z');
}

[[nodiscard]] bool IsForbiddenSegmentCharacter(const wchar_t value) noexcept {
    return value < 0x20 || value == L'"' || value == L'<' || value == L'>' || value == L'|' ||
           value == L'?' || value == L'*' || value == L':' || value == L'/' || value == L'\\';
}

void ValidateSingleSegment(const std::wstring& segment, const char* label) {
    if (segment.empty() || segment == L"." || segment == L".." || segment.back() == L'.' ||
        segment.back() == L' ' ||
        std::any_of(segment.begin(), segment.end(), IsForbiddenSegmentCharacter)) {
        ThrowInvalidPath(label);
    }
}

ParsedPath ParseCanonicalLocalPath(const std::wstring& input) {
    if (input.size() < 3 || input.size() > 32'767 || !IsAsciiDriveLetter(input[0]) ||
        input[1] != L':' || input[2] != L'\\' || input.starts_with(L"\\\\") ||
        (input.size() > 3 && input.back() == L'\\')) {
        ThrowInvalidPath("Windows filesystem operations require a canonical absolute drive path");
    }

    const DWORD required = GetFullPathNameW(input.c_str(), 0, nullptr, nullptr);
    if (required == 0) {
        ThrowWin32(GetLastError(), "GetFullPathNameW failed");
    }
    std::vector<wchar_t> canonical(static_cast<std::size_t>(required));
    const DWORD written = GetFullPathNameW(input.c_str(), required, canonical.data(), nullptr);
    if (written == 0 || written >= required) {
        ThrowWin32(GetLastError(), "GetFullPathNameW returned an invalid canonical path");
    }
    const std::wstring canonical_path(canonical.data(), written);
    if (canonical_path != input) {
        ThrowInvalidPath("Windows filesystem path is not canonical");
    }

    ParsedPath parsed{input.substr(0, 3), {}};
    std::size_t start = 3;
    while (start < input.size()) {
        const std::size_t separator = input.find(L'\\', start);
        const std::size_t end = separator == std::wstring::npos ? input.size() : separator;
        const std::wstring segment = input.substr(start, end - start);
        ValidateSingleSegment(segment, "Windows filesystem path contains an ambiguous segment");
        parsed.segments.push_back(segment);
        if (separator == std::wstring::npos) {
            break;
        }
        start = separator + 1;
    }
    return parsed;
}

[[nodiscard]] ParsedPath ParseCanonicalWslUncReadPath(const std::wstring& input) {
    constexpr std::wstring_view prefix = L"\\\\wsl.localhost\\";
    if (input.size() <= prefix.size() || input.size() > 32'767 || !input.starts_with(prefix)) {
        ThrowInvalidPath("Windows WSL reads require a canonical \\\\wsl.localhost\\<distro> path");
    }

    const std::size_t distro_end = input.find(L'\\', prefix.size());
    if (distro_end == std::wstring::npos) {
        ThrowInvalidPath("Windows WSL UNC share root must end with one canonical separator");
    }
    if (input.back() == L'\\' && distro_end != input.size() - 1U) {
        ThrowInvalidPath("Windows WSL UNC non-root path must not end with a separator");
    }
    const std::size_t distro_length = distro_end - prefix.size();
    const std::wstring distro = input.substr(prefix.size(), distro_length);
    ValidateSingleSegment(distro, "Windows WSL UNC path contains an invalid distro name");

    std::wstring volume_root(prefix);
    volume_root.append(distro);
    volume_root.push_back(L'\\');
    ParsedPath parsed{std::move(volume_root), {}};

    std::size_t start = distro_end + 1U;
    while (start < input.size()) {
        const std::size_t separator = input.find(L'\\', start);
        const std::size_t end = separator == std::wstring::npos ? input.size() : separator;
        const std::wstring segment = input.substr(start, end - start);
        ValidateSingleSegment(segment, "Windows WSL UNC path contains an ambiguous segment");
        parsed.segments.push_back(segment);
        if (separator == std::wstring::npos) {
            break;
        }
        start = separator + 1U;
    }
    return parsed;
}

[[nodiscard]] NtCreateFileFunction ResolveNtCreateFile() {
    const HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    if (ntdll == nullptr) {
        ThrowWin32(GetLastError(), "ntdll.dll is unavailable");
    }
    const auto function = reinterpret_cast<NtCreateFileFunction>(GetProcAddress(ntdll, "NtCreateFile"));
    if (function == nullptr) {
        ThrowWin32(GetLastError(), "NtCreateFile is unavailable");
    }
    return function;
}

[[nodiscard]] NtSetInformationFileFunction ResolveNtSetInformationFile() {
    const HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    if (ntdll == nullptr) {
        ThrowWin32(GetLastError(), "ntdll.dll is unavailable");
    }
    const auto function =
        reinterpret_cast<NtSetInformationFileFunction>(GetProcAddress(ntdll, "NtSetInformationFile"));
    if (function == nullptr) {
        ThrowWin32(GetLastError(), "NtSetInformationFile is unavailable");
    }
    return function;
}

void VerifyLocalNtfs(const std::wstring& volume_root) {
    if (GetDriveTypeW(volume_root.c_str()) != DRIVE_FIXED) {
        throw NativeFailure(FailureKind::unsupported_platform, "WINDOWS_DRIVE_NOT_FIXED",
                            "Windows filesystem operations require a fixed local drive");
    }

    std::array<wchar_t, 32> filesystem_name{};
    if (!GetVolumeInformationW(
            volume_root.c_str(),
            nullptr,
            0,
            nullptr,
            nullptr,
            nullptr,
            filesystem_name.data(),
            static_cast<DWORD>(filesystem_name.size()))) {
        ThrowWin32(GetLastError(), "GetVolumeInformationW failed");
    }
    if (std::wstring(filesystem_name.data()) != L"NTFS") {
        throw NativeFailure(FailureKind::unsupported_platform, "WINDOWS_FILESYSTEM_NOT_NTFS",
                            "Windows filesystem operations currently require NTFS");
    }
}

[[nodiscard]] EntryKind EntryKindFromAttributes(const DWORD attributes) {
    return (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0 ? EntryKind::directory : EntryKind::file;
}

[[nodiscard]] std::uint64_t CombineUnsigned(const DWORD high, const DWORD low) noexcept {
    return (static_cast<std::uint64_t>(high) << 32U) | static_cast<std::uint64_t>(low);
}

[[nodiscard]] std::uint64_t FileTimeValue(const FILETIME& value) noexcept {
    return CombineUnsigned(value.dwHighDateTime, value.dwLowDateTime);
}

[[nodiscard]] std::string HexFileId(const FILE_ID_128& id) {
    constexpr char hex[] = "0123456789abcdef";
    std::string result;
    result.resize(sizeof(id.Identifier) * 2U);
    for (std::size_t index = 0; index < sizeof(id.Identifier); ++index) {
        const std::uint8_t value = id.Identifier[index];
        result[index * 2U] = hex[value >> 4U];
        result[index * 2U + 1U] = hex[value & 0x0FU];
    }
    return result;
}

[[nodiscard]] std::string HexLegacyFileIndex(const DWORD high, const DWORD low) {
    constexpr char hex[] = "0123456789abcdef";
    const std::uint64_t index = CombineUnsigned(high, low);
    if (index == 0) {
        throw NativeFailure(
            FailureKind::unsupported_platform,
            "WINDOWS_STABLE_FILE_INDEX_UNAVAILABLE",
            "Windows filesystem did not expose a stable file index");
    }
    std::string result(32U, '0');
    for (std::size_t offset = 0; offset < 16U; ++offset) {
        const std::size_t shift = (15U - offset) * 4U;
        result[16U + offset] = hex[(index >> shift) & 0x0FU];
    }
    return result;
}

[[nodiscard]] std::string LegacyDeviceNamespace(const DWORD volume_serial) {
    std::string serial = std::to_string(volume_serial);
    return "1" + std::string(20U - serial.size(), '0') + serial;
}

StableSample QueryStableSample(const HANDLE handle) {
    if (GetFileType(handle) != FILE_TYPE_DISK) {
        ThrowWrongEntryType("Windows filesystem operation requires a disk file or directory");
    }
    BY_HANDLE_FILE_INFORMATION information{};
    if (!GetFileInformationByHandle(handle, &information)) {
        ThrowWin32(GetLastError(), "GetFileInformationByHandle failed");
    }
    if ((information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
        ThrowReparse("Windows filesystem operation rejected a reparse-point handle");
    }
    if ((information.dwFileAttributes &
         (FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS)) != 0) {
        throw NativeFailure(FailureKind::unsupported_platform, "WINDOWS_ENTRY_REQUIRES_RECALL",
                            "Windows filesystem operation rejected an offline or recalled entry");
    }

    FILE_ID_INFO identity_information{};
    const bool has_extended_identity = GetFileInformationByHandleEx(
        handle, FileIdInfo, &identity_information, static_cast<DWORD>(sizeof(identity_information)));
    const DWORD identity_error = has_extended_identity ? ERROR_SUCCESS : GetLastError();
    if (!has_extended_identity && identity_error != ERROR_NOT_SUPPORTED) {
        ThrowWin32(identity_error, "GetFileInformationByHandleEx(FileIdInfo) failed");
    }
    FILE_BASIC_INFO basic_information{};
    if (!GetFileInformationByHandleEx(
            handle, FileBasicInfo, &basic_information, static_cast<DWORD>(sizeof(basic_information)))) {
        ThrowWin32(GetLastError(), "GetFileInformationByHandleEx(FileBasicInfo) failed");
    }

    const std::string device_id = has_extended_identity
                                      ? std::to_string(identity_information.VolumeSerialNumber)
                                      : LegacyDeviceNamespace(information.dwVolumeSerialNumber);
    return StableSample{
        PhysicalIdentity{
            std::move(device_id),
            has_extended_identity
                ? HexFileId(identity_information.FileId)
                : HexLegacyFileIndex(information.nFileIndexHigh, information.nFileIndexLow),
            EntryKindFromAttributes(information.dwFileAttributes),
        },
        CombineUnsigned(information.nFileSizeHigh, information.nFileSizeLow),
        FileTimeValue(information.ftLastWriteTime),
        static_cast<std::uint64_t>(basic_information.ChangeTime.QuadPart),
        information.dwFileAttributes,
    };
}

bool SameIdentity(const PhysicalIdentity& left, const PhysicalIdentity& right) noexcept {
    return left.device_id == right.device_id && left.file_id == right.file_id &&
           left.entry_kind == right.entry_kind;
}

bool SameStableSample(const StableSample& left, const StableSample& right) noexcept {
    return SameIdentity(left.identity, right.identity) && left.bytes == right.bytes &&
           left.last_write == right.last_write && left.change_time == right.change_time &&
           left.attributes == right.attributes;
}

[[nodiscard]] UniqueHandle OpenVolumeRoot(
    const std::wstring& volume_root,
    const ACCESS_MASK additional_access,
    const ULONG share_access,
    const bool write_through) {
    VerifyLocalNtfs(volume_root);
    UniqueHandle handle(CreateFileW(
        volume_root.c_str(),
        FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | FILE_TRAVERSE | SYNCHRONIZE |
            additional_access,
        share_access,
        nullptr,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT |
            (write_through ? FILE_FLAG_WRITE_THROUGH : 0),
        nullptr));
    if (!handle.valid()) {
        ThrowWin32(GetLastError(), "CreateFileW could not open the volume root");
    }
    const StableSample sample = QueryStableSample(handle.get());
    if (sample.identity.entry_kind != EntryKind::directory) {
        ThrowWrongEntryType("Windows volume root is not a directory");
    }
    return handle;
}

[[nodiscard]] UniqueHandle OpenWslUncRoot(const std::wstring& volume_root) {
    UniqueHandle handle(CreateFileW(
        volume_root.c_str(),
        FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | FILE_TRAVERSE | SYNCHRONIZE,
        kShareAll,
        nullptr,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
        nullptr));
    if (!handle.valid()) {
        ThrowWin32(GetLastError(), "CreateFileW could not open the selected WSL UNC root");
    }
    const StableSample sample = QueryStableSample(handle.get());
    if (sample.identity.entry_kind != EntryKind::directory) {
        ThrowWrongEntryType("Windows WSL UNC root is not a directory");
    }
    return handle;
}

OpenedRelative CreateRelative(
    const HANDLE parent,
    const std::wstring& segment,
    const EntryKind expected_kind,
    const ACCESS_MASK additional_access,
    const ULONG share_access,
    const ULONG create_disposition,
    const bool write_through) {
    ValidateSingleSegment(segment, "Windows filesystem child name is not one canonical segment");
    if (segment.size() > std::numeric_limits<USHORT>::max() / sizeof(wchar_t)) {
        ThrowInvalidPath("Windows filesystem path segment is too long");
    }

    UNICODE_STRING name{};
    name.Length = static_cast<USHORT>(segment.size() * sizeof(wchar_t));
    name.MaximumLength = name.Length;
    name.Buffer = const_cast<PWSTR>(segment.data());

    OBJECT_ATTRIBUTES attributes{};
    InitializeObjectAttributes(
        &attributes,
        &name,
        kObjectCaseInsensitive | kObjectDontReparse,
        parent,
        nullptr);

    IO_STATUS_BLOCK status_block{};
    HANDLE raw_handle = INVALID_HANDLE_VALUE;
    const ACCESS_MASK access =
        expected_kind == EntryKind::directory
            ? FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | FILE_TRAVERSE | SYNCHRONIZE
            : FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
    const ULONG options =
        kFileSynchronousIoNonAlert | kFileOpenReparsePoint |
        (write_through ? kFileWriteThrough : 0) |
        (expected_kind == EntryKind::directory ? kFileDirectoryFile : kFileNonDirectoryFile);
    const NTSTATUS status = ResolveNtCreateFile()(
        &raw_handle,
        access | additional_access,
        &attributes,
        &status_block,
        nullptr,
        FILE_ATTRIBUTE_NORMAL,
        share_access,
        create_disposition,
        options,
        nullptr,
        0);
    UniqueHandle handle(raw_handle);
    if (status < 0) {
        ThrowNtStatus(status, "NtCreateFile rejected a relative path segment");
    }

    const bool created = status_block.Information == kFileCreated;
    try {
        const StableSample sample = QueryStableSample(handle.get());
        if (sample.identity.entry_kind != expected_kind) {
            ThrowWrongEntryType("Windows filesystem entry has the wrong physical type");
        }
    } catch (const NativeFailure& error) {
        if (created) {
            throw NativeFailure(
                error.failure_kind(),
                error.system_code(),
                error.what(),
                MutationState::may_have_applied);
        }
        throw;
    }
    return OpenedRelative{std::move(handle), created};
}

UniqueHandle OpenRelative(
    const HANDLE parent,
    const std::wstring& segment,
    const EntryKind expected_kind,
    const ACCESS_MASK additional_access,
    const ULONG share_access,
    const bool write_through) {
    OpenedRelative opened = CreateRelative(
        parent,
        segment,
        expected_kind,
        additional_access,
        share_access,
        kFileOpen,
        write_through);
    return std::move(opened.handle);
}

UniqueHandle OpenCanonicalPath(
    const std::wstring& input,
    const EntryKind expected_kind,
    const ACCESS_MASK additional_access,
    const ULONG share_access,
    const bool write_through) {
    const ParsedPath parsed = ParseCanonicalLocalPath(input);
    UniqueHandle current = OpenVolumeRoot(
        parsed.volume_root,
        parsed.segments.empty() ? additional_access : 0,
        parsed.segments.empty() ? share_access : kShareAll,
        parsed.segments.empty() && write_through);
    if (parsed.segments.empty()) {
        if (expected_kind != EntryKind::directory) {
            ThrowWrongEntryType("Windows filesystem operation expected a regular file");
        }
        return current;
    }

    for (std::size_t index = 0; index < parsed.segments.size(); ++index) {
        const EntryKind kind = index + 1U == parsed.segments.size() ? expected_kind : EntryKind::directory;
        const bool final = index + 1U == parsed.segments.size();
        current = OpenRelative(
            current.get(),
            parsed.segments[index],
            kind,
            final ? additional_access : 0,
            final ? share_access : kShareAll,
            final && write_through);
    }
    return current;
}

UniqueHandle OpenCanonicalReadPath(const std::wstring& input, const EntryKind expected_kind) {
    if (!input.starts_with(L"\\\\")) {
        return OpenCanonicalPath(input, expected_kind);
    }
    const ParsedPath parsed = ParseCanonicalWslUncReadPath(input);
    UniqueHandle current = OpenWslUncRoot(parsed.volume_root);
    if (parsed.segments.empty()) {
        if (expected_kind != EntryKind::directory) {
            ThrowWrongEntryType("Windows WSL UNC read expected a regular file");
        }
        return current;
    }
    for (std::size_t index = 0; index < parsed.segments.size(); ++index) {
        const bool final = index + 1U == parsed.segments.size();
        current = OpenRelative(
            current.get(),
            parsed.segments[index],
            final ? expected_kind : EntryKind::directory);
    }
    return current;
}

OpenedParentPath OpenCanonicalParent(
    const std::wstring& input,
    const ACCESS_MASK additional_parent_access,
    const ULONG share_access,
    const bool write_through) {
    const ParsedPath parsed = ParseCanonicalLocalPath(input);
    if (parsed.segments.empty()) {
        ThrowInvalidPath("Windows filesystem mutation requires a non-root target path");
    }
    std::wstring parent_path = parsed.volume_root;
    for (std::size_t index = 0; index + 1U < parsed.segments.size(); ++index) {
        if (parent_path.size() > 3U) {
            parent_path.push_back(L'\\');
        }
        parent_path.append(parsed.segments[index]);
    }
    return OpenedParentPath{
        OpenCanonicalPath(
            parent_path,
            EntryKind::directory,
            additional_parent_access,
            share_access,
            write_through),
        std::move(parent_path),
        parsed.segments.back(),
    };
}

std::wstring JoinCanonicalChild(
    const std::wstring& parent_path,
    const std::wstring& child_name) {
    ValidateSingleSegment(child_name, "Windows filesystem child name is not one canonical segment");
    if (parent_path.size() == 3U) {
        return parent_path + child_name;
    }
    return parent_path + L"\\" + child_name;
}

void WriteExact(const HANDLE handle, const std::vector<std::uint8_t>& bytes) {
    std::size_t offset = 0;
    while (offset < bytes.size()) {
        const DWORD requested = static_cast<DWORD>(std::min<std::size_t>(
            bytes.size() - offset,
            static_cast<std::size_t>(std::numeric_limits<DWORD>::max())));
        DWORD written = 0;
        if (!WriteFile(handle, bytes.data() + offset, requested, &written, nullptr)) {
            ThrowWin32(GetLastError(), "WriteFile failed");
        }
        if (written == 0) {
            throw NativeFailure(
                FailureKind::io_error,
                "WINDOWS_ZERO_BYTE_WRITE",
                "WriteFile made no progress");
        }
        offset += written;
    }
}

void FlushHandle(const HANDLE handle, const char* message) {
    if (!FlushFileBuffers(handle)) {
        ThrowWin32(GetLastError(), message);
    }
}

void RenameHandle(
    const HANDLE entry,
    const HANDLE target_parent,
    const std::wstring& target_name,
    const bool replace_if_exists) {
    ValidateSingleSegment(target_name, "Windows rename target must be one canonical segment");
    if (target_name.size() > std::numeric_limits<ULONG>::max() / sizeof(wchar_t)) {
        ThrowInvalidPath("Windows rename target is too long");
    }
    const std::size_t name_bytes = target_name.size() * sizeof(wchar_t);
    const std::size_t record_bytes = offsetof(RelativeRenameInformation, file_name) + name_bytes;
    if (record_bytes > std::numeric_limits<ULONG>::max()) {
        ThrowInvalidPath("Windows rename record is too large");
    }
    std::vector<std::byte> buffer(record_bytes);
    auto* information = reinterpret_cast<RelativeRenameInformation*>(buffer.data());
    information->replace_if_exists = replace_if_exists ? TRUE : FALSE;
    information->root_directory = target_parent;
    information->file_name_length = static_cast<ULONG>(name_bytes);
    std::memcpy(information->file_name, target_name.data(), name_bytes);

    IO_STATUS_BLOCK status_block{};
    const NTSTATUS status = ResolveNtSetInformationFile()(
        entry,
        &status_block,
        information,
        static_cast<ULONG>(record_bytes),
        kFileRenameInformationClass);
    if (status < 0) {
        ThrowNtStatus(status, "NtSetInformationFile rejected a handle-relative rename");
    }
}

void ThrowMutationFailure(
    const NativeFailure& error,
    const MutationState mutation_state) {
    const MutationState effective_state =
        mutation_state == MutationState::may_have_applied ||
                error.mutation_state() == MutationState::may_have_applied
            ? MutationState::may_have_applied
            : MutationState::not_applied;
    throw NativeFailure(
        error.failure_kind(),
        error.system_code(),
        error.what(),
        effective_state);
}

void ThrowMutationFailure(
    const std::exception& error,
    const MutationState mutation_state) {
    throw NativeFailure(
        FailureKind::io_error,
        "NATIVE_MUTATION_EXCEPTION",
        error.what(),
        mutation_state);
}

void ReadExact(const HANDLE handle, std::vector<std::uint8_t>& bytes) {
    std::size_t offset = 0;
    while (offset < bytes.size()) {
        const std::size_t remaining = bytes.size() - offset;
        const DWORD requested = static_cast<DWORD>(
            std::min<std::size_t>(remaining, static_cast<std::size_t>(std::numeric_limits<DWORD>::max())));
        DWORD read = 0;
        if (!ReadFile(handle, bytes.data() + offset, requested, &read, nullptr)) {
            ThrowWin32(GetLastError(), "ReadFile failed");
        }
        if (read == 0) {
            ThrowStale("regular file became shorter while it was being read");
        }
        offset += read;
    }
}

[[nodiscard]] bool ReadOverflowSentinel(const HANDLE handle) {
    std::uint8_t sentinel = 0;
    DWORD read = 0;
    if (!ReadFile(handle, &sentinel, 1, &read, nullptr)) {
        ThrowWin32(GetLastError(), "ReadFile overflow sentinel failed");
    }
    return read != 0;
}

[[nodiscard]] std::vector<std::wstring> EnumerateNames(const HANDLE directory, const std::uint64_t maximum_entries) {
    std::vector<std::wstring> names;
    std::vector<std::byte> buffer(kDirectoryBufferBytes);
    bool restart = true;

    while (true) {
        const FILE_INFO_BY_HANDLE_CLASS information_class =
            restart ? FileIdBothDirectoryRestartInfo : FileIdBothDirectoryInfo;
        if (!GetFileInformationByHandleEx(
                directory,
                information_class,
                buffer.data(),
                static_cast<DWORD>(buffer.size()))) {
            const DWORD error = GetLastError();
            if (error == ERROR_NO_MORE_FILES) {
                break;
            }
            ThrowWin32(error, "GetFileInformationByHandleEx(directory) failed");
        }
        restart = false;

        std::size_t offset = 0;
        while (true) {
            if (offset + sizeof(FILE_ID_BOTH_DIR_INFO) > buffer.size()) {
                throw NativeFailure(FailureKind::io_error, "DIRECTORY_BUFFER_INVALID",
                                    "Windows directory enumeration returned an invalid record");
            }
            const auto* record = reinterpret_cast<const FILE_ID_BOTH_DIR_INFO*>(buffer.data() + offset);
            if ((record->FileNameLength % sizeof(wchar_t)) != 0 ||
                offset + offsetof(FILE_ID_BOTH_DIR_INFO, FileName) + record->FileNameLength > buffer.size()) {
                throw NativeFailure(FailureKind::io_error, "DIRECTORY_BUFFER_INVALID",
                                    "Windows directory enumeration returned an invalid name");
            }
            const std::wstring name(record->FileName, record->FileNameLength / sizeof(wchar_t));
            if (name != L"." && name != L"..") {
                if (names.size() >= maximum_entries) {
                    ThrowResourceLimit("directory exceeds the caller's bounded inventory limit");
                }
                names.push_back(name);
            }
            if (record->NextEntryOffset == 0) {
                break;
            }
            if (record->NextEntryOffset < offsetof(FILE_ID_BOTH_DIR_INFO, FileName) ||
                offset + record->NextEntryOffset >= buffer.size()) {
                throw NativeFailure(FailureKind::io_error, "DIRECTORY_BUFFER_INVALID",
                                    "Windows directory enumeration returned an invalid offset");
            }
            offset += record->NextEntryOffset;
        }
    }

    std::sort(names.begin(), names.end());
    return names;
}

}  // namespace detail

using detail::EnumerateNames;
using detail::IsForbiddenSegmentCharacter;
using detail::OpenCanonicalPath;
using detail::OpenCanonicalReadPath;
using detail::OpenRelative;
using detail::QueryStableSample;
using detail::ReadExact;
using detail::ReadOverflowSentinel;
using detail::SameStableSample;
using detail::StableSample;
using detail::UniqueHandle;
using detail::kMaximumJavaScriptInteger;

StableRegularFileRead ReadRegularFileNoFollow(
    const std::wstring& file_path,
    const std::uint64_t maximum_bytes) {
    if (maximum_bytes > kMaximumJavaScriptInteger) {
        ThrowResourceLimit("maximumBytes exceeds JavaScript's exact integer range");
    }
    UniqueHandle file = OpenCanonicalReadPath(file_path, EntryKind::file);
    const StableSample before = QueryStableSample(file.get());
    if (before.bytes > maximum_bytes ||
        before.bytes > static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max())) {
        ThrowResourceLimit("regular file exceeds the caller's bounded-read byte limit");
    }

    std::vector<std::uint8_t> bytes(static_cast<std::size_t>(before.bytes));
    ReadExact(file.get(), bytes);
    const bool overflow = ReadOverflowSentinel(file.get());
    const StableSample after = QueryStableSample(file.get());
    if (overflow && after.bytes > maximum_bytes) {
        ThrowResourceLimit("regular file grew beyond the caller's bounded-read byte limit");
    }
    if (overflow || !SameStableSample(before, after)) {
        ThrowStale("regular file changed while it was being read");
    }
    return StableRegularFileRead{std::move(bytes), false, after.identity};
}

StableRegularFileRangeRead ReadRegularFileRangeNoFollow(
    const std::wstring& file_path,
    const std::uint64_t byte_offset,
    const std::uint64_t maximum_bytes) {
    if (byte_offset > kMaximumJavaScriptInteger || maximum_bytes == 0 ||
        maximum_bytes > kMaximumJavaScriptInteger) {
        ThrowResourceLimit("byte range exceeds JavaScript's exact integer range");
    }
    UniqueHandle file = OpenCanonicalReadPath(file_path, EntryKind::file);
    const StableSample before = QueryStableSample(file.get());
    if (before.bytes > kMaximumJavaScriptInteger || byte_offset > before.bytes) {
        ThrowResourceLimit("byteOffset is outside the safely addressable regular file");
    }

    LARGE_INTEGER position{};
    position.QuadPart = static_cast<LONGLONG>(byte_offset);
    if (!SetFilePointerEx(file.get(), position, nullptr, FILE_BEGIN)) {
        ThrowWin32(GetLastError(), "SetFilePointerEx failed");
    }
    const std::uint64_t requested = std::min(maximum_bytes, before.bytes - byte_offset);
    if (requested > static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max())) {
        ThrowResourceLimit("requested byte range exceeds the native allocation limit");
    }
    std::vector<std::uint8_t> bytes(static_cast<std::size_t>(requested));
    ReadExact(file.get(), bytes);
    const StableSample after = QueryStableSample(file.get());
    if (!SameStableSample(before, after)) {
        ThrowStale("regular file changed while a byte range was being read");
    }
    return StableRegularFileRangeRead{
        std::move(bytes),
        byte_offset,
        after.bytes,
        false,
        after.identity,
    };
}

PhysicalIdentity InspectRegularFileNoFollow(const std::wstring& file_path) {
    UniqueHandle file = OpenCanonicalReadPath(file_path, EntryKind::file);
    const StableSample before = QueryStableSample(file.get());
    const StableSample after = QueryStableSample(file.get());
    if (!SameStableSample(before, after)) {
        ThrowStale("regular file changed while its identity was being inspected");
    }
    return after.identity;
}

PhysicalIdentity InspectDirectoryNoFollow(const std::wstring& directory_path) {
    UniqueHandle directory = OpenCanonicalReadPath(directory_path, EntryKind::directory);
    const StableSample before = QueryStableSample(directory.get());
    const StableSample after = QueryStableSample(directory.get());
    if (!SameStableSample(before, after)) {
        ThrowStale("directory changed while its identity was being inspected");
    }
    return after.identity;
}

StableDirectoryInventory InventoryDirectoryNoFollow(
    const std::wstring& directory_path,
    const std::uint64_t maximum_entries) {
    if (maximum_entries > static_cast<std::uint64_t>(std::numeric_limits<std::uint32_t>::max())) {
        ThrowResourceLimit("maximumEntries exceeds the maximum JavaScript array length");
    }
    UniqueHandle directory = OpenCanonicalReadPath(directory_path, EntryKind::directory);
    const StableSample before = QueryStableSample(directory.get());
    const std::vector<std::wstring> names = EnumerateNames(directory.get(), maximum_entries);

    std::vector<StableDirectoryInventoryEntry> entries;
    entries.reserve(names.size());
    for (const std::wstring& name : names) {
        if (name.empty() || std::any_of(name.begin(), name.end(), IsForbiddenSegmentCharacter)) {
            throw NativeFailure(FailureKind::io_error, "DIRECTORY_NAME_INVALID",
                                "Windows directory enumeration returned an invalid child name");
        }

        UniqueHandle child;
        try {
            child = OpenRelative(directory.get(), name, EntryKind::file);
        } catch (const NativeFailure& file_error) {
            if (file_error.failure_kind() == FailureKind::wrong_entry_type) {
                child = OpenRelative(directory.get(), name, EntryKind::directory);
            } else {
                throw;
            }
        }
        const StableSample child_sample = QueryStableSample(child.get());
        entries.push_back(StableDirectoryInventoryEntry{name, child_sample.identity});
    }

    const StableSample after = QueryStableSample(directory.get());
    if (!SameStableSample(before, after)) {
        ThrowStale("directory changed while it was being inventoried");
    }
    return StableDirectoryInventory{after.identity, std::move(entries)};
}

}  // namespace oaam::win32
