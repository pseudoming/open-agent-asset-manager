#pragma once

#ifndef _WIN32
#error "OAAM's Windows filesystem addon may only be built for Windows."
#endif

#include <windows.h>
#include <winternl.h>

#include <array>
#include <cstdint>
#include <exception>
#include <memory>
#include <string>
#include <vector>

#include "native-errors.h"

namespace oaam::win32 {

enum class EntryKind {
    file,
    directory,
};

struct PhysicalIdentity {
    std::string device_id;
    std::string file_id;
    EntryKind entry_kind;
};

struct StableRegularFileRead {
    std::vector<std::uint8_t> bytes;
    bool executable;
    PhysicalIdentity identity;
};

struct StableRegularFileRangeRead {
    std::vector<std::uint8_t> bytes;
    std::uint64_t byte_offset;
    std::uint64_t total_bytes;
    bool executable;
    PhysicalIdentity identity;
};

struct StableDirectoryInventoryEntry {
    std::wstring relative_name;
    PhysicalIdentity identity;
};

struct StableDirectoryInventory {
    PhysicalIdentity identity;
    std::vector<StableDirectoryInventoryEntry> entries;
};

struct EnsuredDirectory {
    PhysicalIdentity identity;
    bool created;
};

/**
 * Private deterministic fault modes used only by the raw native proof.
 *
 * The installed TypeScript wrapper never forwards these modes. The native
 * implementation additionally requires an exact current-run proof root
 * through OAAM_WINDOWS_NATIVE_TEST_ROOT before honoring any mode.
 */
enum class NativeMutationFaultForTest {
    none,
    replace_parent_before_publish,
    terminate_after_temp_flush,
    terminate_after_publish,
    recycle_fixed_stage_success,
    recycle_fixed_stage_sharing_violation,
    recycle_tree_fixed_stage_success,
    recycle_tree_retry_first_operation_failure,
    recycle_tree_hang_during_operation,
};

[[nodiscard]] StableRegularFileRead ReadRegularFileNoFollow(
    const std::wstring& file_path,
    std::uint64_t maximum_bytes);

[[nodiscard]] StableRegularFileRangeRead ReadRegularFileRangeNoFollow(
    const std::wstring& file_path,
    std::uint64_t byte_offset,
    std::uint64_t maximum_bytes);

[[nodiscard]] PhysicalIdentity InspectRegularFileNoFollow(
    const std::wstring& file_path);

[[nodiscard]] PhysicalIdentity InspectDirectoryNoFollow(
    const std::wstring& directory_path);

[[nodiscard]] StableDirectoryInventory InventoryDirectoryNoFollow(
    const std::wstring& directory_path,
    std::uint64_t maximum_entries);

[[nodiscard]] StableRegularFileRead ConfirmDurableRegularFileNoFollow(
    const std::wstring& file_path);

[[nodiscard]] PhysicalIdentity ConfirmDurableDirectoryNoFollow(
    const std::wstring& directory_path);

[[nodiscard]] PhysicalIdentity ConfirmDurableDirectoryTreeNoFollow(
    const std::wstring& directory_path,
    std::uint64_t maximum_entries);

[[nodiscard]] EnsuredDirectory DurableEnsureDirectory(
    const std::wstring& parent_path,
    const std::wstring& child_name);

[[nodiscard]] PhysicalIdentity DurableReplaceFile(
    const std::wstring& file_path,
    const std::vector<std::uint8_t>& bytes,
    NativeMutationFaultForTest test_fault);

[[nodiscard]] PhysicalIdentity DurableCreateFile(
    const std::wstring& file_path,
    const std::vector<std::uint8_t>& bytes);

[[nodiscard]] bool DurableRemoveRegularFile(
    const std::wstring& file_path,
    NativeMutationFaultForTest test_fault);

[[nodiscard]] bool PermanentlyRemoveRegularFileIfIdentity(
    const std::wstring& file_path,
    const PhysicalIdentity& expected_identity);

[[nodiscard]] bool DurableRecycleRegularFileIfIdentity(
    const std::wstring& file_path,
    const PhysicalIdentity& expected_identity);

[[nodiscard]] bool DurableRecycleDirectoryTreeIfIdentity(
    const std::wstring& directory_path,
    const PhysicalIdentity& expected_identity,
    std::uint64_t maximum_entries);

[[nodiscard]] bool DurableRemoveDirectoryTree(
    const std::wstring& directory_path,
    std::uint64_t maximum_entries,
    NativeMutationFaultForTest test_fault);

[[nodiscard]] PhysicalIdentity DurablePublishFile(
    const std::wstring& source_path,
    const std::wstring& target_parent_path,
    const std::wstring& target_name);

[[nodiscard]] PhysicalIdentity DurablePublishDirectory(
    const std::wstring& staged_directory_path,
    const std::wstring& target_parent_path,
    const std::wstring& target_name,
    std::uint64_t maximum_entries);

class LockLease;

struct LockLeaseDeleter final {
    void operator()(LockLease* lease) const noexcept;
};

using LockLeaseOwner = std::unique_ptr<LockLease, LockLeaseDeleter>;

[[nodiscard]] LockLeaseOwner AcquirePersistentLock(const std::wstring& lock_path);

void ReleasePersistentLock(LockLease& lease) noexcept;

namespace detail {

constexpr DWORD kShareAll = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
constexpr ULONG kNativeFileCreate = 0x00000002UL;
constexpr ULONG kNativeFileOpenIf = 0x00000003UL;

class UniqueHandle final {
  public:
    UniqueHandle() noexcept = default;
    explicit UniqueHandle(HANDLE value) noexcept;
    ~UniqueHandle();

    UniqueHandle(const UniqueHandle&) = delete;
    UniqueHandle& operator=(const UniqueHandle&) = delete;

    UniqueHandle(UniqueHandle&& other) noexcept;
    UniqueHandle& operator=(UniqueHandle&& other) noexcept;

    [[nodiscard]] HANDLE get() const noexcept;
    [[nodiscard]] bool valid() const noexcept;
    [[nodiscard]] HANDLE release() noexcept;
    void reset(HANDLE replacement = INVALID_HANDLE_VALUE) noexcept;

  private:
    HANDLE value_ = INVALID_HANDLE_VALUE;
};

struct ParsedPath {
    std::wstring volume_root;
    std::vector<std::wstring> segments;
};

struct StableSample {
    PhysicalIdentity identity;
    std::uint64_t bytes;
    std::uint64_t last_write;
    std::uint64_t change_time;
    DWORD attributes;
};

struct OpenedParentPath {
    UniqueHandle parent;
    std::wstring parent_path;
    std::wstring child_name;
};

struct OpenedRelative {
    UniqueHandle handle;
    bool created;
};

[[nodiscard]] ParsedPath ParseCanonicalLocalPath(const std::wstring& input);
void ValidateSingleSegment(const std::wstring& segment, const char* label);

[[nodiscard]] StableSample QueryStableSample(HANDLE handle);
[[nodiscard]] bool SameIdentity(
    const PhysicalIdentity& left,
    const PhysicalIdentity& right) noexcept;
[[nodiscard]] bool SameStableSample(
    const StableSample& left,
    const StableSample& right) noexcept;

[[nodiscard]] UniqueHandle OpenCanonicalPath(
    const std::wstring& input,
    EntryKind expected_kind,
    ACCESS_MASK additional_access = 0,
    ULONG share_access = kShareAll,
    bool write_through = false);

/** Read-only opener for canonical local NTFS paths or the exact WSL UNC namespace. */
[[nodiscard]] UniqueHandle OpenCanonicalReadPath(
    const std::wstring& input,
    EntryKind expected_kind);

[[nodiscard]] UniqueHandle OpenRelative(
    HANDLE parent,
    const std::wstring& segment,
    EntryKind expected_kind,
    ACCESS_MASK additional_access = 0,
    ULONG share_access = kShareAll,
    bool write_through = false);

[[nodiscard]] OpenedRelative CreateRelative(
    HANDLE parent,
    const std::wstring& segment,
    EntryKind expected_kind,
    ACCESS_MASK additional_access,
    ULONG share_access,
    ULONG create_disposition,
    bool write_through);

[[nodiscard]] OpenedParentPath OpenCanonicalParent(
    const std::wstring& input,
    ACCESS_MASK additional_parent_access = 0,
    ULONG share_access = kShareAll,
    bool write_through = false);

void WriteExact(HANDLE handle, const std::vector<std::uint8_t>& bytes);
void FlushHandle(HANDLE handle, const char* message);

void RenameHandle(
    HANDLE entry,
    HANDLE target_parent,
    const std::wstring& target_name,
    bool replace_if_exists);

[[nodiscard]] std::wstring JoinCanonicalChild(
    const std::wstring& parent_path,
    const std::wstring& child_name);

void RecycleStagedEntry(
    const std::wstring& staged_path,
    HANDLE held_entry,
    const PhysicalIdentity& expected_identity,
    bool fail_first_operation_for_test,
    bool hang_during_operation_for_test);

[[noreturn]] void ThrowMutationFailure(
    const NativeFailure& error,
    MutationState mutation_state);

[[noreturn]] void ThrowMutationFailure(
    const std::exception& error,
    MutationState mutation_state);

}  // namespace detail

}  // namespace oaam::win32
