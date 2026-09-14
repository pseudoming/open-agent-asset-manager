#include "safe-read.h"

#include "native-errors.h"

#include <objbase.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <cwchar>
#include <limits>
#include <string>
#include <utility>
#include <vector>

namespace oaam::win32 {
namespace {

constexpr std::uint64_t kMaximumJavaScriptInteger = 9'007'199'254'740'991ULL;
constexpr DWORD kLockFlags = LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY;
constexpr DWORD kShareWithoutDelete = FILE_SHARE_READ | FILE_SHARE_WRITE;

[[nodiscard]] std::wstring UniqueSegment(const wchar_t* prefix) {
    GUID identifier{};
    const HRESULT result = CoCreateGuid(&identifier);
    if (FAILED(result)) {
        throw NativeFailure(
            FailureKind::io_error,
            "WINDOWS_GUID_CREATION_FAILED",
            "CoCreateGuid could not allocate a private filesystem name");
    }
    std::array<wchar_t, 96> buffer{};
    const int written = std::swprintf(
        buffer.data(),
        buffer.size(),
        L"%ls%08lx%04x%04x%02x%02x%02x%02x%02x%02x%02x%02x",
        prefix,
        static_cast<unsigned long>(identifier.Data1),
        static_cast<unsigned int>(identifier.Data2),
        static_cast<unsigned int>(identifier.Data3),
        static_cast<unsigned int>(identifier.Data4[0]),
        static_cast<unsigned int>(identifier.Data4[1]),
        static_cast<unsigned int>(identifier.Data4[2]),
        static_cast<unsigned int>(identifier.Data4[3]),
        static_cast<unsigned int>(identifier.Data4[4]),
        static_cast<unsigned int>(identifier.Data4[5]),
        static_cast<unsigned int>(identifier.Data4[6]),
        static_cast<unsigned int>(identifier.Data4[7]));
    if (written <= 0 || static_cast<std::size_t>(written) >= buffer.size()) {
        throw NativeFailure(
            FailureKind::io_error,
            "WINDOWS_GUID_FORMAT_FAILED",
            "private filesystem name formatting failed");
    }
    return std::wstring(buffer.data(), static_cast<std::size_t>(written));
}

[[nodiscard]] bool SameBytes(
    const std::vector<std::uint8_t>& left,
    const std::vector<std::uint8_t>& right) noexcept {
    return left.size() == right.size() &&
           std::equal(left.begin(), left.end(), right.begin());
}

[[nodiscard]] bool SameInventory(
    const StableDirectoryInventory& left,
    const StableDirectoryInventory& right) noexcept {
    if (!detail::SameIdentity(left.identity, right.identity) ||
        left.entries.size() != right.entries.size()) {
        return false;
    }
    for (std::size_t index = 0; index < left.entries.size(); ++index) {
        if (left.entries[index].relative_name != right.entries[index].relative_name ||
            !detail::SameIdentity(
                left.entries[index].identity,
                right.entries[index].identity)) {
            return false;
        }
    }
    return true;
}

[[nodiscard]] bool RelativeEntryIsMissing(
    const HANDLE parent,
    const std::wstring& name) {
    try {
        static_cast<void>(
            detail::OpenRelative(parent, name, EntryKind::file));
        return false;
    } catch (const NativeFailure& file_error) {
        if (file_error.failure_kind() == FailureKind::not_found) {
            return true;
        }
        if (file_error.failure_kind() != FailureKind::wrong_entry_type) {
            throw;
        }
    }
    static_cast<void>(
        detail::OpenRelative(parent, name, EntryKind::directory));
    return false;
}

void RequireRelativeAbsent(
    const HANDLE parent,
    const std::wstring& name,
    const char* message) {
    if (!RelativeEntryIsMissing(parent, name)) {
        throw NativeFailure(FailureKind::io_error, "WINDOWS_TARGET_EXISTS", message);
    }
}

[[nodiscard]] bool CanonicalPathIsMissing(
    const std::wstring& path,
    const EntryKind expected_kind) {
    try {
        static_cast<void>(detail::OpenCanonicalPath(path, expected_kind));
        return false;
    } catch (const NativeFailure& error) {
        if (error.failure_kind() == FailureKind::not_found) {
            return true;
        }
        throw;
    }
}

void RequireAuthorizedTestFault(
    const std::wstring& target_path,
    const NativeMutationFaultForTest test_fault) {
    if (test_fault == NativeMutationFaultForTest::none) {
        return;
    }
    constexpr DWORD kMaximumEnvironmentPath = 32'768;
    std::vector<wchar_t> buffer(kMaximumEnvironmentPath);
    const DWORD length = GetEnvironmentVariableW(
        L"OAAM_WINDOWS_NATIVE_TEST_ROOT",
        buffer.data(),
        static_cast<DWORD>(buffer.size()));
    if (length == 0 || length >= buffer.size()) {
        throw NativeFailure(
            FailureKind::permission_denied,
            "NATIVE_TEST_FAULT_NOT_AUTHORIZED",
            "native mutation fault requires an exact current-run proof root");
    }
    const std::wstring proof_root(buffer.data(), length);
    std::vector<wchar_t> local_app_data_buffer(kMaximumEnvironmentPath);
    const DWORD local_app_data_length = GetEnvironmentVariableW(
        L"LOCALAPPDATA",
        local_app_data_buffer.data(),
        static_cast<DWORD>(local_app_data_buffer.size()));
    if (local_app_data_length == 0 ||
        local_app_data_length >= local_app_data_buffer.size()) {
        throw NativeFailure(
            FailureKind::permission_denied,
            "NATIVE_TEST_FAULT_NOT_AUTHORIZED",
            "native mutation fault requires the current Windows local temporary root");
    }
    const std::wstring local_temporary_root =
        std::wstring(local_app_data_buffer.data(), local_app_data_length) +
        L"\\Temp";
    const detail::ParsedPath parsed_proof_root =
        detail::ParseCanonicalLocalPath(proof_root);
    const detail::ParsedPath parsed_temporary_root =
        detail::ParseCanonicalLocalPath(local_temporary_root);
    static_cast<void>(detail::ParseCanonicalLocalPath(target_path));
    const std::wstring owned_prefix = L"oaam-windows-proof-";
    const bool same_volume =
        CompareStringOrdinal(
            parsed_proof_root.volume_root.data(),
            static_cast<int>(parsed_proof_root.volume_root.size()),
            parsed_temporary_root.volume_root.data(),
            static_cast<int>(parsed_temporary_root.volume_root.size()),
            TRUE) == CSTR_EQUAL;
    bool inside_temporary_segments =
        parsed_proof_root.segments.size() >
        parsed_temporary_root.segments.size();
    if (inside_temporary_segments) {
        for (std::size_t index = 0;
             index < parsed_temporary_root.segments.size();
             ++index) {
            if (CompareStringOrdinal(
                    parsed_proof_root.segments[index].data(),
                    static_cast<int>(parsed_proof_root.segments[index].size()),
                    parsed_temporary_root.segments[index].data(),
                    static_cast<int>(parsed_temporary_root.segments[index].size()),
                    TRUE) != CSTR_EQUAL) {
                inside_temporary_segments = false;
                break;
            }
        }
    }
    bool current_run_name = false;
    if (!parsed_proof_root.segments.empty()) {
        const std::wstring& owned_name = parsed_proof_root.segments.back();
        current_run_name =
            owned_name.size() > owned_prefix.size() &&
            CompareStringOrdinal(
                owned_name.data(),
                static_cast<int>(owned_prefix.size()),
                owned_prefix.data(),
                static_cast<int>(owned_prefix.size()),
                TRUE) == CSTR_EQUAL;
    }
    if (!same_volume || !inside_temporary_segments || !current_run_name ||
        target_path.size() <= proof_root.size() ||
        target_path[proof_root.size()] != L'\\' ||
        CompareStringOrdinal(
            target_path.data(),
            static_cast<int>(proof_root.size()),
            proof_root.data(),
            static_cast<int>(proof_root.size()),
            TRUE) != CSTR_EQUAL) {
        throw NativeFailure(
            FailureKind::permission_denied,
            "NATIVE_TEST_FAULT_OUTSIDE_PROOF_ROOT",
            "native mutation fault target is outside the exact current-run proof root");
    }
}

[[nodiscard]] std::wstring RecycleStageName(
    const NativeMutationFaultForTest test_fault) {
    switch (test_fault) {
        case NativeMutationFaultForTest::recycle_fixed_stage_success:
            return L".oaam-recycle-proof-success";
        case NativeMutationFaultForTest::recycle_fixed_stage_sharing_violation:
            return L".oaam-recycle-proof-blocked";
        case NativeMutationFaultForTest::recycle_tree_fixed_stage_success:
            return L".oaam-recycle-proof-tree";
        case NativeMutationFaultForTest::recycle_tree_retry_first_operation_failure:
            return L".oaam-recycle-proof-tree-retry";
        case NativeMutationFaultForTest::recycle_tree_hang_during_operation:
            return L".oaam-recycle-proof-tree-hang";
        default:
            return UniqueSegment(L".oaam-recycle-");
    }
}

void ReplaceParentPathForTest(const std::wstring& parent_path) {
    detail::OpenedParentPath grandparent = detail::OpenCanonicalParent(
        parent_path,
        FILE_ADD_SUBDIRECTORY | FILE_DELETE_CHILD,
        detail::kShareAll,
        true);
    detail::UniqueHandle parent = detail::OpenRelative(
        grandparent.parent.get(),
        grandparent.child_name,
        EntryKind::directory,
        DELETE,
        detail::kShareAll,
        true);
    const std::wstring displaced_name = L".oaam-parent-displaced-proof";
    RequireRelativeAbsent(
        grandparent.parent.get(),
        displaced_name,
        "test-only displaced parent already exists");
    detail::RenameHandle(
        parent.get(),
        grandparent.parent.get(),
        displaced_name,
        false);
    static_cast<void>(detail::CreateRelative(
        grandparent.parent.get(),
        grandparent.child_name,
        EntryKind::directory,
        DELETE,
        detail::kShareAll,
        detail::kNativeFileCreate,
        true));
}

[[noreturn]] void TerminateAtTestCheckpoint(const UINT exit_code) {
    if (!TerminateProcess(GetCurrentProcess(), exit_code)) {
        ThrowWin32(
            GetLastError(),
            "TerminateProcess could not activate the native crash checkpoint");
    }
    std::terminate();
}

void ConfirmDirectoryTreeRecursive(
    const std::wstring& directory_path,
    const std::uint64_t maximum_entries,
    std::uint64_t& observed_entries) {
    const std::uint64_t remaining = maximum_entries - observed_entries;
    const StableDirectoryInventory before =
        InventoryDirectoryNoFollow(directory_path, remaining);
    for (const StableDirectoryInventoryEntry& entry : before.entries) {
        if (observed_entries >= maximum_entries) {
            ThrowResourceLimit(
                "directory tree exceeds the caller's bounded-entry limit");
        }
        ++observed_entries;
        const std::wstring child_path =
            detail::JoinCanonicalChild(directory_path, entry.relative_name);
        if (entry.identity.entry_kind == EntryKind::directory) {
            ConfirmDirectoryTreeRecursive(
                child_path,
                maximum_entries,
                observed_entries);
        } else {
            const StableRegularFileRead confirmed =
                ConfirmDurableRegularFileNoFollow(child_path);
            if (!detail::SameIdentity(entry.identity, confirmed.identity)) {
                ThrowStale(
                    "directory-tree file identity changed during durability confirmation");
            }
        }
    }
    static_cast<void>(ConfirmDurableDirectoryNoFollow(directory_path));
    const StableDirectoryInventory after =
        InventoryDirectoryNoFollow(directory_path, before.entries.size());
    if (!SameInventory(before, after)) {
        ThrowStale("directory tree changed during durability confirmation");
    }
}

[[nodiscard]] bool DurableRecyclePath(
    const std::wstring& source_path,
    const EntryKind expected_kind,
    const std::uint64_t maximum_entries,
    const NativeMutationFaultForTest test_fault,
    const PhysicalIdentity* expected_identity = nullptr) {
    bool staged = false;
    try {
        RequireAuthorizedTestFault(source_path, test_fault);
        if (expected_kind == EntryKind::directory) {
            if (CanonicalPathIsMissing(source_path, expected_kind)) {
                return false;
            }
            static_cast<void>(
                ConfirmDurableDirectoryTreeNoFollow(source_path, maximum_entries));
        }

        detail::OpenedParentPath source_parent = detail::OpenCanonicalParent(
            source_path,
            FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY | FILE_DELETE_CHILD,
            detail::kShareAll,
            true);
        detail::UniqueHandle source;
        try {
            source = detail::OpenRelative(
                source_parent.parent.get(),
                source_parent.child_name,
                expected_kind,
                DELETE,
                detail::kShareAll,
                true);
        } catch (const NativeFailure& error) {
            if (error.failure_kind() == FailureKind::not_found) {
                return false;
            }
            throw;
        }
        const detail::StableSample source_sample =
            detail::QueryStableSample(source.get());
        if (expected_identity != nullptr &&
            !detail::SameIdentity(source_sample.identity, *expected_identity)) {
            ThrowStale("recycle source does not match the caller's expected physical identity");
        }
        const std::wstring staged_name = RecycleStageName(test_fault);
        RequireRelativeAbsent(
            source_parent.parent.get(),
            staged_name,
            "private recycle staging path already exists");
        detail::RenameHandle(
            source.get(),
            source_parent.parent.get(),
            staged_name,
            false);
        staged = true;

        if (!CanonicalPathIsMissing(source_path, expected_kind)) {
            ThrowStale("source path remained present after recycle staging");
        }
        const std::wstring staged_path =
            detail::JoinCanonicalChild(source_parent.parent_path, staged_name);
        detail::UniqueHandle staged_entry = detail::OpenRelative(
            source_parent.parent.get(),
            staged_name,
            expected_kind,
            0,
            detail::kShareAll,
            true);
        const detail::StableSample staged_sample =
            detail::QueryStableSample(staged_entry.get());
        if (!detail::SameIdentity(
                source_sample.identity,
                staged_sample.identity)) {
            ThrowStale("recycle staging changed the physical source identity");
        }
        if (expected_kind == EntryKind::directory) {
            static_cast<void>(
                ConfirmDurableDirectoryTreeNoFollow(staged_path, maximum_entries));
        }
        detail::UniqueHandle test_delete_blocker;
        if (test_fault ==
            NativeMutationFaultForTest::recycle_fixed_stage_sharing_violation) {
            test_delete_blocker = detail::OpenCanonicalPath(
                staged_path,
                expected_kind,
                GENERIC_READ,
                kShareWithoutDelete,
                true);
        }
        detail::RecycleStagedEntry(
            staged_path,
            source.get(),
            source_sample.identity,
            test_fault ==
                NativeMutationFaultForTest::recycle_tree_retry_first_operation_failure,
            test_fault ==
                NativeMutationFaultForTest::recycle_tree_hang_during_operation);
        if (!CanonicalPathIsMissing(staged_path, expected_kind)) {
            throw NativeFailure(
                FailureKind::io_error,
                "WINDOWS_RECYCLE_STAGE_REMAINS",
                "Recycle Bin operation left the staged path present");
        }
        return true;
    } catch (const NativeFailure& error) {
        detail::ThrowMutationFailure(
            error,
            staged ? MutationState::may_have_applied : MutationState::not_applied);
    } catch (const std::exception& error) {
        detail::ThrowMutationFailure(
            error,
            staged ? MutationState::may_have_applied : MutationState::not_applied);
    } catch (...) {
        throw NativeFailure(
            FailureKind::io_error,
            "NATIVE_MUTATION_UNKNOWN_EXCEPTION",
            "native recycle operation failed",
            staged ? MutationState::may_have_applied : MutationState::not_applied);
    }
}

}  // namespace

class LockLease final {
  public:
    explicit LockLease(detail::UniqueHandle handle) noexcept
        : handle_(std::move(handle)) {}

    detail::UniqueHandle handle_;
    OVERLAPPED overlap_{};
    bool locked_ = true;
};

StableRegularFileRead ConfirmDurableRegularFileNoFollow(
    const std::wstring& file_path) {
    const StableRegularFileRead before =
        ReadRegularFileNoFollow(file_path, kMaximumJavaScriptInteger);
    detail::UniqueHandle file = detail::OpenCanonicalPath(
        file_path,
        EntryKind::file,
        GENERIC_WRITE,
        detail::kShareAll,
        true);
    const detail::StableSample opened = detail::QueryStableSample(file.get());
    if (!detail::SameIdentity(before.identity, opened.identity)) {
        ThrowStale("regular file changed before durability confirmation");
    }
    detail::FlushHandle(
        file.get(),
        "FlushFileBuffers could not confirm regular-file durability");
    const detail::StableSample flushed = detail::QueryStableSample(file.get());
    if (!detail::SameIdentity(opened.identity, flushed.identity)) {
        ThrowStale("regular file identity changed during durability confirmation");
    }
    const StableRegularFileRead after =
        ReadRegularFileNoFollow(file_path, before.bytes.size());
    if (!detail::SameIdentity(before.identity, after.identity) ||
        !SameBytes(before.bytes, after.bytes)) {
        ThrowStale("regular file path changed after durability confirmation");
    }
    return after;
}

PhysicalIdentity ConfirmDurableDirectoryNoFollow(
    const std::wstring& directory_path) {
    detail::UniqueHandle directory = detail::OpenCanonicalPath(
        directory_path,
        EntryKind::directory,
        0,
        detail::kShareAll,
        true);
    const detail::StableSample before =
        detail::QueryStableSample(directory.get());
    const detail::StableSample after =
        detail::QueryStableSample(directory.get());
    if (!detail::SameIdentity(before.identity, after.identity)) {
        ThrowStale("directory identity changed during durability confirmation");
    }
    detail::UniqueHandle reopened =
        detail::OpenCanonicalPath(directory_path, EntryKind::directory);
    const detail::StableSample reopened_sample =
        detail::QueryStableSample(reopened.get());
    if (!detail::SameIdentity(after.identity, reopened_sample.identity)) {
        ThrowStale("directory path changed after durability confirmation");
    }
    return reopened_sample.identity;
}

PhysicalIdentity ConfirmDurableDirectoryTreeNoFollow(
    const std::wstring& directory_path,
    const std::uint64_t maximum_entries) {
    if (maximum_entries > std::numeric_limits<std::uint32_t>::max()) {
        ThrowResourceLimit(
            "maximumEntries exceeds the maximum native directory-tree limit");
    }
    std::uint64_t observed_entries = 0;
    ConfirmDirectoryTreeRecursive(
        directory_path,
        maximum_entries,
        observed_entries);
    return ConfirmDurableDirectoryNoFollow(directory_path);
}

EnsuredDirectory DurableEnsureDirectory(
    const std::wstring& parent_path,
    const std::wstring& child_name) {
    const std::wstring target_path =
        detail::JoinCanonicalChild(parent_path, child_name);
    bool created = false;
    try {
        detail::UniqueHandle parent = detail::OpenCanonicalPath(
            parent_path,
            EntryKind::directory,
            FILE_ADD_SUBDIRECTORY | FILE_DELETE_CHILD,
            detail::kShareAll,
            true);
        detail::OpenedRelative ensured = detail::CreateRelative(
            parent.get(),
            child_name,
            EntryKind::directory,
            DELETE,
            detail::kShareAll,
            detail::kNativeFileOpenIf,
            true);
        created = ensured.created;
        const detail::StableSample before =
            detail::QueryStableSample(ensured.handle.get());
        detail::UniqueHandle reopened = detail::OpenRelative(
            parent.get(),
            child_name,
            EntryKind::directory);
        const detail::StableSample after =
            detail::QueryStableSample(reopened.get());
        if (!detail::SameIdentity(before.identity, after.identity)) {
            ThrowStale("ensured directory identity changed before verification");
        }
        return EnsuredDirectory{after.identity, created};
    } catch (const NativeFailure& error) {
        detail::ThrowMutationFailure(
            error,
            created ? MutationState::may_have_applied : MutationState::not_applied);
    } catch (const std::exception& error) {
        detail::ThrowMutationFailure(
            error,
            created ? MutationState::may_have_applied : MutationState::not_applied);
    } catch (...) {
        throw NativeFailure(
            FailureKind::io_error,
            "NATIVE_MUTATION_UNKNOWN_EXCEPTION",
            "native directory ensure failed",
            created ? MutationState::may_have_applied : MutationState::not_applied);
    }
}

namespace {

PhysicalIdentity DurablePublishFile(
    const std::wstring& file_path,
    const std::vector<std::uint8_t>& bytes,
    const NativeMutationFaultForTest test_fault,
    const bool replace_existing) {
    bool published = false;
    try {
        RequireAuthorizedTestFault(file_path, test_fault);
        detail::OpenedParentPath target = detail::OpenCanonicalParent(
            file_path,
            FILE_ADD_FILE | FILE_DELETE_CHILD,
            detail::kShareAll,
            true);
        if (replace_existing) {
            try {
                static_cast<void>(detail::OpenRelative(
                    target.parent.get(),
                    target.child_name,
                    EntryKind::file));
            } catch (const NativeFailure& error) {
                if (error.failure_kind() != FailureKind::not_found) {
                    throw;
                }
            }
        } else {
            if (!RelativeEntryIsMissing(target.parent.get(), target.child_name)) {
                throw NativeFailure(
                    FailureKind::stale,
                    "WINDOWS_TARGET_EXISTS",
                    "durable create refuses to replace an existing destination");
            }
        }
        if (test_fault ==
            NativeMutationFaultForTest::replace_parent_before_publish) {
            ReplaceParentPathForTest(target.parent_path);
        }

        const std::wstring temporary_name =
            UniqueSegment(L".oaam-publish-");
        detail::OpenedRelative temporary = detail::CreateRelative(
            target.parent.get(),
            temporary_name,
            EntryKind::file,
            GENERIC_WRITE | DELETE,
            detail::kShareAll,
            detail::kNativeFileCreate,
            true);
        detail::WriteExact(temporary.handle.get(), bytes);
        detail::FlushHandle(
            temporary.handle.get(),
            "FlushFileBuffers could not persist replacement bytes");
        if (test_fault ==
            NativeMutationFaultForTest::terminate_after_temp_flush) {
            TerminateAtTestCheckpoint(86);
        }
        const detail::StableSample replacement =
            detail::QueryStableSample(temporary.handle.get());
        detail::RenameHandle(
            temporary.handle.get(),
            target.parent.get(),
            target.child_name,
            replace_existing);
        published = true;
        detail::FlushHandle(
            temporary.handle.get(),
            "FlushFileBuffers could not persist replacement publication");
        if (test_fault ==
            NativeMutationFaultForTest::terminate_after_publish) {
            TerminateAtTestCheckpoint(87);
        }

        const StableRegularFileRead verified =
            ReadRegularFileNoFollow(file_path, bytes.size());
        if (!detail::SameIdentity(
                replacement.identity,
                verified.identity) ||
            !SameBytes(bytes, verified.bytes)) {
            ThrowStale(
                "durable replacement verification did not match published bytes");
        }
        return verified.identity;
    } catch (const NativeFailure& error) {
        detail::ThrowMutationFailure(
            error,
            published ? MutationState::may_have_applied : MutationState::not_applied);
    } catch (const std::exception& error) {
        detail::ThrowMutationFailure(
            error,
            published ? MutationState::may_have_applied : MutationState::not_applied);
    } catch (...) {
        throw NativeFailure(
            FailureKind::io_error,
            "NATIVE_MUTATION_UNKNOWN_EXCEPTION",
            "native durable replacement failed",
            published ? MutationState::may_have_applied : MutationState::not_applied);
    }
}

}  // namespace

PhysicalIdentity DurableReplaceFile(
    const std::wstring& file_path,
    const std::vector<std::uint8_t>& bytes,
    const NativeMutationFaultForTest test_fault) {
    return DurablePublishFile(file_path, bytes, test_fault, true);
}

PhysicalIdentity DurableCreateFile(
    const std::wstring& file_path,
    const std::vector<std::uint8_t>& bytes) {
    return DurablePublishFile(
        file_path,
        bytes,
        NativeMutationFaultForTest::none,
        false);
}

bool DurableRemoveRegularFile(
    const std::wstring& file_path,
    const NativeMutationFaultForTest test_fault) {
    return DurableRecyclePath(file_path, EntryKind::file, 0, test_fault);
}

bool PermanentlyRemoveRegularFileIfIdentity(
    const std::wstring& file_path,
    const PhysicalIdentity& expected_identity) {
    bool staged = false;
    bool deletion_requested = false;
    try {
        detail::OpenedParentPath source_parent = detail::OpenCanonicalParent(
            file_path,
            FILE_ADD_FILE | FILE_DELETE_CHILD,
            detail::kShareAll,
            true);
        detail::UniqueHandle source;
        try {
            source = detail::OpenRelative(
                source_parent.parent.get(),
                source_parent.child_name,
                EntryKind::file,
                DELETE,
                detail::kShareAll,
                true);
        } catch (const NativeFailure& error) {
            if (error.failure_kind() == FailureKind::not_found) {
                return false;
            }
            throw;
        }
        const detail::StableSample source_sample =
            detail::QueryStableSample(source.get());
        if (!detail::SameIdentity(source_sample.identity, expected_identity)) {
            ThrowStale(
                "permanent removal source does not match the caller's expected physical identity");
        }

        const std::wstring staged_name =
            UniqueSegment(L".oaam-permanent-delete-");
        RequireRelativeAbsent(
            source_parent.parent.get(),
            staged_name,
            "private permanent-removal staging path already exists");
        detail::RenameHandle(
            source.get(),
            source_parent.parent.get(),
            staged_name,
            false);
        staged = true;
        if (!CanonicalPathIsMissing(file_path, EntryKind::file)) {
            ThrowStale(
                "source path remained present after permanent-removal staging");
        }

        const std::wstring staged_path =
            detail::JoinCanonicalChild(source_parent.parent_path, staged_name);
        detail::UniqueHandle staged_entry = detail::OpenRelative(
            source_parent.parent.get(),
            staged_name,
            EntryKind::file,
            DELETE,
            detail::kShareAll,
            true);
        const detail::StableSample staged_sample =
            detail::QueryStableSample(staged_entry.get());
        if (!detail::SameIdentity(
                source_sample.identity,
                staged_sample.identity)) {
            ThrowStale(
                "permanent-removal staging changed the physical source identity");
        }

        FILE_DISPOSITION_INFO_EX disposition{};
        disposition.Flags =
            FILE_DISPOSITION_FLAG_DELETE |
            FILE_DISPOSITION_FLAG_POSIX_SEMANTICS |
            FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE;
        if (SetFileInformationByHandle(
                staged_entry.get(),
                FileDispositionInfoEx,
                &disposition,
                sizeof(disposition)) == FALSE) {
            ThrowWin32(
                GetLastError(),
                "SetFileInformationByHandle could not permanently remove the exact staged file");
        }
        deletion_requested = true;
        staged_entry.reset();
        source.reset();
        if (!CanonicalPathIsMissing(staged_path, EntryKind::file)) {
            throw NativeFailure(
                FailureKind::io_error,
                "WINDOWS_PERMANENT_DELETE_STAGE_REMAINS",
                "permanent removal left the exact staged path present");
        }
        return true;
    } catch (const NativeFailure& error) {
        detail::ThrowMutationFailure(
            error,
            staged || deletion_requested
                ? MutationState::may_have_applied
                : MutationState::not_applied);
    } catch (const std::exception& error) {
        detail::ThrowMutationFailure(
            error,
            staged || deletion_requested
                ? MutationState::may_have_applied
                : MutationState::not_applied);
    } catch (...) {
        throw NativeFailure(
            FailureKind::io_error,
            "NATIVE_MUTATION_UNKNOWN_EXCEPTION",
            "native permanent file removal failed",
            staged || deletion_requested
                ? MutationState::may_have_applied
                : MutationState::not_applied);
    }
}

bool DurableRecycleRegularFileIfIdentity(
    const std::wstring& file_path,
    const PhysicalIdentity& expected_identity) {
    return DurableRecyclePath(
        file_path,
        EntryKind::file,
        0,
        NativeMutationFaultForTest::none,
        &expected_identity);
}

bool DurableRecycleDirectoryTreeIfIdentity(
    const std::wstring& directory_path,
    const PhysicalIdentity& expected_identity,
    const std::uint64_t maximum_entries) {
    return DurableRecyclePath(
        directory_path,
        EntryKind::directory,
        maximum_entries,
        NativeMutationFaultForTest::none,
        &expected_identity);
}

bool DurableRemoveDirectoryTree(
    const std::wstring& directory_path,
    const std::uint64_t maximum_entries,
    const NativeMutationFaultForTest test_fault) {
    return DurableRecyclePath(
        directory_path,
        EntryKind::directory,
        maximum_entries,
        test_fault);
}

static PhysicalIdentity DurablePublishEntry(
    const std::wstring& staged_directory_path,
    const std::wstring& target_parent_path,
    const std::wstring& target_name,
    const std::uint64_t maximum_entries, const EntryKind kind) {
    bool published = false;
    try {
        const PhysicalIdentity staged_identity =
            kind == EntryKind::directory
                ? ConfirmDurableDirectoryTreeNoFollow(staged_directory_path, maximum_entries)
                : ConfirmDurableRegularFileNoFollow(staged_directory_path).identity;
        detail::OpenedParentPath source = detail::OpenCanonicalParent(
            staged_directory_path,
            FILE_ADD_SUBDIRECTORY | FILE_ADD_FILE | FILE_DELETE_CHILD,
            detail::kShareAll,
            true);
        detail::UniqueHandle staged = detail::OpenRelative(
            source.parent.get(),
            source.child_name,
            kind,
            DELETE,
            detail::kShareAll,
            true);
        detail::UniqueHandle target_parent = detail::OpenCanonicalPath(
            target_parent_path,
            EntryKind::directory,
            FILE_ADD_SUBDIRECTORY | FILE_ADD_FILE | FILE_DELETE_CHILD,
            detail::kShareAll,
            true);
        RequireRelativeAbsent(
            target_parent.get(),
            target_name,
            "directory publication target already exists");
        const detail::StableSample target_parent_sample =
            detail::QueryStableSample(target_parent.get());
        if (target_parent_sample.identity.device_id !=
            staged_identity.device_id) {
            throw NativeFailure(
                FailureKind::unsupported_platform,
                "WINDOWS_CROSS_VOLUME_PUBLICATION",
                "directory publication requires one NTFS volume");
        }

        detail::RenameHandle(
            staged.get(),
            target_parent.get(),
            target_name,
            false);
        published = true;
        const std::wstring target_path =
            detail::JoinCanonicalChild(target_parent_path, target_name);
        const PhysicalIdentity published_identity =
            kind == EntryKind::directory
                ? ConfirmDurableDirectoryTreeNoFollow(target_path, maximum_entries)
                : ConfirmDurableRegularFileNoFollow(target_path).identity;
        if (!detail::SameIdentity(
                staged_identity,
                published_identity)) {
            ThrowStale(
                "directory publication changed the staged physical identity");
        }
        return published_identity;
    } catch (const NativeFailure& error) {
        detail::ThrowMutationFailure(
            error,
            published ? MutationState::may_have_applied : MutationState::not_applied);
    } catch (const std::exception& error) {
        detail::ThrowMutationFailure(
            error,
            published ? MutationState::may_have_applied : MutationState::not_applied);
    } catch (...) {
        throw NativeFailure(
            FailureKind::io_error,
            "NATIVE_MUTATION_UNKNOWN_EXCEPTION",
            "native directory publication failed",
            published ? MutationState::may_have_applied : MutationState::not_applied);
    }
}

PhysicalIdentity DurablePublishDirectory(
    const std::wstring& source_path, const std::wstring& target_parent_path,
    const std::wstring& target_name, const std::uint64_t maximum_entries) {
    return DurablePublishEntry(source_path, target_parent_path, target_name, maximum_entries, EntryKind::directory);
}

PhysicalIdentity DurablePublishFile(
    const std::wstring& source_path, const std::wstring& target_parent_path,
    const std::wstring& target_name) {
    return DurablePublishEntry(source_path, target_parent_path, target_name, 0, EntryKind::file);
}

LockLeaseOwner AcquirePersistentLock(const std::wstring& lock_path) {
    detail::OpenedParentPath target = detail::OpenCanonicalParent(
        lock_path,
        FILE_ADD_FILE,
        detail::kShareAll,
        true);
    detail::OpenedRelative anchor = detail::CreateRelative(
        target.parent.get(),
        target.child_name,
        EntryKind::file,
        GENERIC_READ | GENERIC_WRITE,
        kShareWithoutDelete,
        detail::kNativeFileOpenIf,
        true);
    auto lease = std::make_unique<LockLease>(std::move(anchor.handle));
    if (!LockFileEx(
            lease->handle_.get(),
            kLockFlags,
            0,
            1,
            0,
            &lease->overlap_)) {
        const DWORD error = GetLastError();
        if (error == ERROR_LOCK_VIOLATION ||
            error == ERROR_SHARING_VIOLATION) {
            return {};
        }
        ThrowWin32(error, "LockFileEx failed");
    }
    return LockLeaseOwner(lease.release());
}

void ReleasePersistentLock(LockLease& lease) noexcept {
    if (lease.locked_) {
        static_cast<void>(UnlockFileEx(
            lease.handle_.get(),
            0,
            1,
            0,
            &lease.overlap_));
        lease.locked_ = false;
        lease.handle_.reset();
    }
}

void LockLeaseDeleter::operator()(LockLease* lease) const noexcept {
    if (lease == nullptr) {
        return;
    }
    ReleasePersistentLock(*lease);
    std::default_delete<LockLease>{}(lease);
}

}  // namespace oaam::win32
