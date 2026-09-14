#ifndef __linux__
#error "OAAM's selected-WSL mutation helper may only be built for Linux."
#endif

#include <linux/openat2.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/utsname.h>
#include <sys/prctl.h>
#include <signal.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <cerrno>
#include <charconv>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "sha256.h"

namespace {

using oaam::wsl_file_mutation::FinishSha256;
using oaam::wsl_file_mutation::HashBytes;
using oaam::wsl_file_mutation::Sha256;
using oaam::wsl_file_mutation::UpdateSha256;

constexpr std::array<std::uint8_t, 8> kRequestMagic{'O', 'A', 'A', 'M', 'W', 'F', 'M', '1'};
constexpr std::array<std::uint8_t, 8> kReceiptMagic{'O', 'A', 'A', 'M', 'W', 'F', 'R', '1'};
constexpr std::uint16_t kSchemaVersion = 1;
constexpr std::size_t kRequestHeaderBytes = 96;
constexpr std::size_t kReceiptBytes = 200;
constexpr std::size_t kMaximumRootBytes = 4U * 1024U;
constexpr std::size_t kMaximumPathBytes = 4U * 1024U;
constexpr std::size_t kMaximumPayloadBytes = 16U * 1024U * 1024U;
constexpr std::uint64_t kResolveFlags =
    RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS;

enum class Operation : std::uint8_t {
    unknown = 0,
    publish_directory = 7,
    publish_file = 8,
};

[[nodiscard]] constexpr bool IsPublication(const Operation operation) {
    return operation == Operation::publish_directory || operation == Operation::publish_file;
}


enum class Status : std::uint8_t {
    complete = 1,
    failed = 2,
};

enum class Certainty : std::uint8_t {
    not_applied = 1,
    may_have_applied = 2,
    applied_verified = 3,
};

enum class Failure : std::uint8_t {
    none = 0,
    invalid_frame = 1,
    unsupported_architecture = 2,
    invalid_path = 3,
    parent_open_failed = 4,
    target_not_found = 5,
    target_conflict = 6,
    symlink_or_magiclink = 7,
    wrong_entry_type = 8,
    permission_denied = 9,
    resource_limit = 10,
    temp_collision = 11,
    write_failed = 12,
    temp_fsync_failed = 13,
    rename_failed = 14,
    parent_fsync_failed = 15,
    readback_failed = 16,
    remove_failed = 17,
    cleanup_failed = 18,
    identity_changed = 19,
    unsupported_operation = 20,
    io_error = 21,
    timeout = 22,
    chmod_failed = 23,
    directory_not_empty = 24,
};

#if defined(OAAM_WSL_FILE_MUTATION_TEST_FAULTS)
enum class TestFault : std::uint8_t {
    none = 0,
    rename = 3,
    parent_fsync = 4,
    readback = 5,
    unsupported_architecture = 9,
    directory_target_race = 13,
    directory_source_race = 14,
    directory_pause_before_publish = 15,
};
#else
enum class TestFault : std::uint8_t {
    none = 0,
};
#endif

class FileDescriptor final {
  public:
    FileDescriptor() = default;
    explicit FileDescriptor(const int value) : value_(value) {}
    ~FileDescriptor() {
        if (value_ >= 0) {
            static_cast<void>(close(value_));
        }
    }

    FileDescriptor(const FileDescriptor&) = delete;
    FileDescriptor& operator=(const FileDescriptor&) = delete;

    FileDescriptor(FileDescriptor&& other) noexcept : value_(std::exchange(other.value_, -1)) {}
    FileDescriptor& operator=(FileDescriptor&& other) noexcept {
        if (this != &other) {
            if (value_ >= 0) {
                static_cast<void>(close(value_));
            }
            value_ = std::exchange(other.value_, -1);
        }
        return *this;
    }

    [[nodiscard]] int get() const { return value_; }
    [[nodiscard]] bool valid() const { return value_ >= 0; }
    [[nodiscard]] int release() { return std::exchange(value_, -1); }
    void reset() {
        if (value_ >= 0) {
            static_cast<void>(close(value_));
            value_ = -1;
        }
    }

  private:
    int value_ = -1;
};

void ZeroMemory(void* const data, const std::size_t size) {
    volatile auto* cursor = static_cast<volatile std::uint8_t*>(data);
    for (std::size_t index = 0; index < size; ++index) {
        cursor[index] = 0;
    }
}

void ZeroBytes(std::vector<std::uint8_t>& bytes) {
    ZeroMemory(bytes.data(), bytes.size());
    bytes.clear();
    bytes.shrink_to_fit();
}

class ScopedMemoryZero final {
  public:
    ScopedMemoryZero(void* const data, const std::size_t size) : data_(data), size_(size) {}
    ~ScopedMemoryZero() { ZeroMemory(data_, size_); }
    ScopedMemoryZero(const ScopedMemoryZero&) = delete;
    ScopedMemoryZero& operator=(const ScopedMemoryZero&) = delete;

  private:
    void* data_;
    std::size_t size_;
};

class SecretBytes final {
  public:
    SecretBytes() = default;
    ~SecretBytes() { ZeroBytes(value); }
    SecretBytes(const SecretBytes&) = delete;
    SecretBytes& operator=(const SecretBytes&) = delete;
    SecretBytes(SecretBytes&& other) noexcept : value(std::move(other.value)) {}
    SecretBytes& operator=(SecretBytes&& other) noexcept {
        if (this != &other) {
            ZeroBytes(value);
            value = std::move(other.value);
        }
        return *this;
    }
    std::vector<std::uint8_t> value;
};

[[nodiscard]] bool ReadExact(const int descriptor, std::uint8_t* output, const std::size_t bytes) {
    std::size_t offset = 0;
    while (offset < bytes) {
        const ssize_t count = read(descriptor, output + offset, bytes - offset);
        if (count == 0) return false;
        if (count < 0) {
            if (errno == EINTR) continue;
            return false;
        }
        offset += static_cast<std::size_t>(count);
    }
    return true;
}

[[nodiscard]] bool WriteExact(const int descriptor, const std::uint8_t* input, const std::size_t bytes) {
    std::size_t offset = 0;
    while (offset < bytes) {
        const ssize_t count = write(descriptor, input + offset, bytes - offset);
        if (count < 0) {
            if (errno == EINTR) continue;
            return false;
        }
        if (count == 0) return false;
        offset += static_cast<std::size_t>(count);
    }
    return true;
}

[[nodiscard]] std::uint16_t ReadU16(const std::uint8_t* input) {
    return static_cast<std::uint16_t>(input[0]) |
           static_cast<std::uint16_t>(static_cast<std::uint16_t>(input[1]) << 8U);
}

[[nodiscard]] std::uint32_t ReadU32(const std::uint8_t* input) {
    std::uint32_t value = 0;
    for (std::size_t index = 0; index < 4; ++index) {
        value |= static_cast<std::uint32_t>(input[index]) << (index * 8U);
    }
    return value;
}

[[nodiscard]] std::uint64_t ReadU64(const std::uint8_t* input) {
    std::uint64_t value = 0;
    for (std::size_t index = 0; index < 8; ++index) {
        value |= static_cast<std::uint64_t>(input[index]) << (index * 8U);
    }
    return value;
}

void WriteU16(std::uint8_t* output, const std::uint16_t value) {
    for (std::size_t index = 0; index < 2; ++index) {
        output[index] = static_cast<std::uint8_t>(value >> (index * 8U));
    }
}

void WriteU64(std::uint8_t* output, const std::uint64_t value) {
    for (std::size_t index = 0; index < 8; ++index) {
        output[index] = static_cast<std::uint8_t>(value >> (index * 8U));
    }
}

[[nodiscard]] bool IsValidUtf8(const std::vector<std::uint8_t>& input) {
    std::size_t index = 0;
    while (index < input.size()) {
        const std::uint8_t first = input[index];
        if (first == 0) return false;
        if (first <= 0x7fU) {
            ++index;
            continue;
        }
        std::size_t continuation = 0;
        std::uint32_t scalar = 0;
        if ((first & 0xe0U) == 0xc0U) {
            continuation = 1;
            scalar = first & 0x1fU;
        } else if ((first & 0xf0U) == 0xe0U) {
            continuation = 2;
            scalar = first & 0x0fU;
        } else if ((first & 0xf8U) == 0xf0U) {
            continuation = 3;
            scalar = first & 0x07U;
        } else {
            return false;
        }
        if (index + continuation >= input.size()) return false;
        for (std::size_t offset = 1; offset <= continuation; ++offset) {
            const std::uint8_t next = input[index + offset];
            if ((next & 0xc0U) != 0x80U) return false;
            scalar = (scalar << 6U) | (next & 0x3fU);
        }
        if ((continuation == 1 && scalar < 0x80U) ||
            (continuation == 2 && scalar < 0x800U) ||
            (continuation == 3 && scalar < 0x10000U) ||
            scalar > 0x10ffffU ||
            (scalar >= 0xd800U && scalar <= 0xdfffU)) {
            return false;
        }
        index += continuation + 1U;
    }
    return true;
}

[[nodiscard]] bool IsCanonicalAbsolutePath(const std::string& value, const bool allow_root) {
    if (value.empty() || value.front() != '/') return false;
    if (value == "/") return allow_root;
    if (value.back() == '/') return false;
    std::size_t segment_start = 1;
    while (segment_start < value.size()) {
        const std::size_t delimiter = value.find('/', segment_start);
        const std::size_t segment_end = delimiter == std::string::npos ? value.size() : delimiter;
        const std::string_view segment(value.data() + segment_start, segment_end - segment_start);
        if (segment.empty() || segment == "." || segment == "..") return false;
        segment_start = segment_end + 1U;
    }
    return true;
}

struct Identity final {
    std::uint64_t device = 0;
    std::uint64_t inode = 0;
};

[[nodiscard]] Identity IdentityFromStat(const struct stat& value) {
    return Identity{static_cast<std::uint64_t>(value.st_dev), static_cast<std::uint64_t>(value.st_ino)};
}

[[nodiscard]] bool SameIdentity(const Identity& left, const Identity& right) {
    return left.device == right.device && left.inode == right.inode;
}

[[nodiscard]] int OpenAt2(
    const int directory,
    const char* relative_path,
    const int flags,
    const mode_t mode = 0) {
    struct open_how how {};
    how.flags = static_cast<__u64>(static_cast<unsigned int>(flags));
    how.mode = static_cast<__u64>(mode);
    how.resolve = kResolveFlags;
    return static_cast<int>(syscall(SYS_openat2, directory, relative_path, &how, sizeof(how)));
}

[[nodiscard]] Failure FailureFromErrno(const int value, const Failure fallback) {
    if (value == EACCES || value == EPERM) return Failure::permission_denied;
    if (value == ELOOP || value == EXDEV) return Failure::symlink_or_magiclink;
    if (value == ENOTDIR || value == EISDIR) return Failure::wrong_entry_type;
    if (value == ENAMETOOLONG || value == EFBIG) return Failure::resource_limit;
    return fallback;
}

[[nodiscard]] bool ReadDirectoryIdentity(
    const int parent,
    const std::string& name,
    Identity& output,
    Failure& failure) {
    FileDescriptor directory(OpenAt2(parent, name.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
    if (!directory.valid()) {
        failure = FailureFromErrno(errno, errno == ENOENT ? Failure::target_not_found : Failure::io_error);
        return false;
    }
    struct stat value {};
    if (fstat(directory.get(), &value) != 0 || !S_ISDIR(value.st_mode)) {
        failure = FailureFromErrno(errno, Failure::wrong_entry_type);
        return false;
    }
    output = IdentityFromStat(value);
    return true;
}

[[nodiscard]] bool ReadPublicationIdentity(
    const int parent, const std::string& name, const Operation operation,
    Identity& output, Failure& failure) {
    if (operation == Operation::publish_directory) return ReadDirectoryIdentity(parent, name, output, failure);
    FileDescriptor file(OpenAt2(parent, name.c_str(), O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW));
    if (!file.valid()) {
        failure = FailureFromErrno(errno, errno == ENOENT ? Failure::target_not_found : Failure::io_error);
        return false;
    }
    struct stat value {};
    if (fstat(file.get(), &value) != 0 || !S_ISREG(value.st_mode)) {
        failure = Failure::wrong_entry_type;
        return false;
    }
    if (fsync(file.get()) != 0) {
        failure = Failure::io_error;
        return false;
    }
    output = IdentityFromStat(value);
    return true;
}

struct Request final {
    Operation operation = Operation::unknown;
    bool expected_present = false;
    bool expected_executable = false;
    bool desired_executable = false;
    TestFault test_fault = TestFault::none;
    std::array<std::uint8_t, 32> nonce{};
    Identity expected_identity{};
    Identity expected_source_parent{};
    Identity expected_destination_parent{};
    std::string root_path;
    std::string target_path;
    SecretBytes payload;

    ~Request() {
        ZeroMemory(root_path.data(), root_path.size());
        ZeroMemory(target_path.data(), target_path.size());
        ZeroMemory(nonce.data(), nonce.size());
    }
};

[[nodiscard]] bool ParseRequest(
    const std::array<std::uint8_t, 8>& magic,
    Request& request,
    Failure& failure) {
    std::array<std::uint8_t, kRequestHeaderBytes> header{};
    const ScopedMemoryZero header_zero(header.data(), header.size());
    std::copy(magic.begin(), magic.end(), header.begin());
    if (!ReadExact(STDIN_FILENO, header.data() + magic.size(), header.size() - magic.size()) ||
        !std::equal(kRequestMagic.begin(), kRequestMagic.end(), header.begin()) ||
        ReadU16(header.data() + 8) != (IsPublication(static_cast<Operation>(header[10])) ? 2U :
            kSchemaVersion) ||
        header[13] != 0 || header[14] != 0 || header[15] != 0) {
        failure = Failure::invalid_frame;
        return false;
    }
    request.operation = static_cast<Operation>(header[10]);
    if (IsPublication(request.operation)) {
        // This entry cannot outlive its own bounded publication window, even if
        // an external invocation owner disappears or stops delivering input.
        sigset_t signals;
        if (sigemptyset(&signals) != 0 || sigaddset(&signals, SIGALRM) != 0 ||
            sigprocmask(SIG_UNBLOCK, &signals, nullptr) != 0 || signal(SIGALRM, SIG_DFL) == SIG_ERR) {
            failure = Failure::io_error;
            return false;
        }
        static_cast<void>(alarm(5U));
        std::array<std::uint8_t, 16> parents{};
        const ScopedMemoryZero parents_zero(parents.data(), parents.size());
        if (!ReadExact(STDIN_FILENO, parents.data(), parents.size())) {
            failure = Failure::invalid_frame;
            return false;
        }
        request.expected_source_parent = Identity{ReadU64(parents.data()), ReadU64(parents.data() + 8)};
        request.expected_destination_parent = Identity{ReadU64(header.data() + 80), ReadU64(header.data() + 88)};
        if (request.expected_source_parent.device == 0 || request.expected_source_parent.inode == 0 ||
            request.expected_destination_parent.device == 0 || request.expected_destination_parent.inode == 0) {
            failure = Failure::invalid_frame;
            return false;
        }
    }
    request.expected_present = (header[11] & 0x01U) != 0;
    request.expected_executable = (header[11] & 0x02U) != 0;
    request.desired_executable = (header[11] & 0x04U) != 0;
    if ((header[11] & 0xf8U) != 0) {
        failure = Failure::invalid_frame;
        return false;
    }
    request.test_fault = static_cast<TestFault>(header[12]);
#if defined(OAAM_WSL_FILE_MUTATION_TEST_FAULTS)
    switch (request.test_fault) {
        case TestFault::none:
        case TestFault::rename:
        case TestFault::parent_fsync:
        case TestFault::readback:
        case TestFault::unsupported_architecture:
        case TestFault::directory_target_race:
        case TestFault::directory_source_race:
        case TestFault::directory_pause_before_publish:
            break;
        default:
            failure = Failure::invalid_frame;
            return false;
    }
#else
    if (request.test_fault != TestFault::none) {
        failure = Failure::invalid_frame;
        return false;
    }
#endif
    if (!IsPublication(request.operation)) {
        failure = Failure::unsupported_operation;
        return false;
    }
    const std::uint32_t root_bytes = ReadU32(header.data() + 16);
    const std::uint32_t target_bytes = ReadU32(header.data() + 20);
    const std::uint64_t payload_bytes = ReadU64(header.data() + 24);
    if (root_bytes == 0 || root_bytes > kMaximumRootBytes ||
        target_bytes == 0 || target_bytes > kMaximumPathBytes ||
        payload_bytes == 0 || payload_bytes > kMaximumPathBytes || !request.expected_present ||
        request.expected_executable || request.desired_executable) {
        failure = Failure::resource_limit;
        return false;
    }
    std::copy(header.begin() + 32, header.begin() + 64, request.nonce.begin());
    request.expected_identity.device = ReadU64(header.data() + 64);
    request.expected_identity.inode = ReadU64(header.data() + 72);
    if (request.expected_identity.device == 0 || request.expected_identity.inode == 0 ||
        std::all_of(request.nonce.begin(), request.nonce.end(), [](const std::uint8_t value) { return value == 0; })) {
        failure = Failure::invalid_frame;
        return false;
    }
    std::vector<std::uint8_t> root(root_bytes);
    std::vector<std::uint8_t> target(target_bytes);
    const ScopedMemoryZero root_zero(root.data(), root.size());
    const ScopedMemoryZero target_zero(target.data(), target.size());
    request.payload.value.resize(static_cast<std::size_t>(payload_bytes));
    if (!ReadExact(STDIN_FILENO, root.data(), root.size()) ||
        !ReadExact(STDIN_FILENO, target.data(), target.size()) ||
        !ReadExact(STDIN_FILENO, request.payload.value.data(), request.payload.value.size())) {
        failure = Failure::invalid_frame;
        return false;
    }
    std::uint8_t trailing = 0;
    for (;;) {
        const ssize_t count = read(STDIN_FILENO, &trailing, 1);
        if (count == 0) break;
        if (count < 0 && errno == EINTR) continue;
        failure = Failure::invalid_frame;
        return false;
    }
    if (!IsValidUtf8(root) || !IsValidUtf8(target) ||
        (IsPublication(request.operation) && !IsValidUtf8(request.payload.value))) {
        failure = Failure::invalid_path;
        return false;
    }
    request.root_path.assign(reinterpret_cast<const char*>(root.data()), root.size());
    request.target_path.assign(reinterpret_cast<const char*>(target.data()), target.size());
    if (!IsCanonicalAbsolutePath(request.root_path, IsPublication(request.operation)) ||
        !IsCanonicalAbsolutePath(request.target_path, false)) {
        failure = Failure::invalid_path;
        return false;
    }
    const std::size_t delimiter = request.target_path.rfind('/');
    const std::string target_parent = delimiter == 0 ? "/" : request.target_path.substr(0, delimiter);
    if (delimiter == std::string::npos || target_parent != request.root_path) {
        failure = Failure::invalid_path;
        return false;
    }
    return true;
}

struct Receipt final {
    Status status = Status::failed;
    Certainty certainty = Certainty::not_applied;
    Operation operation = Operation::unknown;
    Failure failure = Failure::invalid_frame;
    bool cleanup_complete = true;
    std::uint64_t byte_size = 0;
    Identity parent_before{};
    Identity parent_after{};
    Identity target_before{};
    Identity target_after{};
    Identity helper_identity{};
    std::array<std::uint8_t, 32> content_sha256{};
    std::array<std::uint8_t, 32> helper_sha256{};
    std::array<std::uint8_t, 32> nonce{};
};

void WriteIdentity(std::uint8_t* output, const Identity& identity) {
    WriteU64(output, identity.device);
    WriteU64(output + 8, identity.inode);
}

[[nodiscard]] bool EmitReceipt(const Receipt& receipt) {
    std::array<std::uint8_t, kReceiptBytes> bytes{};
    const ScopedMemoryZero receipt_zero(bytes.data(), bytes.size());
    std::copy(kReceiptMagic.begin(), kReceiptMagic.end(), bytes.begin());
    WriteU16(bytes.data() + 8, kSchemaVersion);
    bytes[10] = static_cast<std::uint8_t>(receipt.status);
    bytes[11] = static_cast<std::uint8_t>(receipt.certainty);
    bytes[12] = static_cast<std::uint8_t>(receipt.operation);
    bytes[13] = static_cast<std::uint8_t>(receipt.failure);
    bytes[14] = receipt.cleanup_complete ? 1U : 0U;
    WriteU64(bytes.data() + 16, receipt.byte_size);
    WriteIdentity(bytes.data() + 24, receipt.parent_before);
    WriteIdentity(bytes.data() + 40, receipt.parent_after);
    WriteIdentity(bytes.data() + 56, receipt.target_before);
    WriteIdentity(bytes.data() + 72, receipt.target_after);
    WriteIdentity(bytes.data() + 88, receipt.helper_identity);
    std::copy(receipt.content_sha256.begin(), receipt.content_sha256.end(), bytes.begin() + 104);
    std::copy(receipt.helper_sha256.begin(), receipt.helper_sha256.end(), bytes.begin() + 136);
    std::copy(receipt.nonce.begin(), receipt.nonce.end(), bytes.begin() + 168);
    return WriteExact(STDOUT_FILENO, bytes.data(), bytes.size());
}

[[nodiscard]] bool ReadDescriptorIdentityAndHash(FileDescriptor& file, Receipt& receipt) {
    struct stat before {};
    if (fstat(file.get(), &before) != 0 || !S_ISREG(before.st_mode) || before.st_size < 0) return false;
    Sha256 hash;
    std::array<std::uint8_t, 16U * 1024U> buffer{};
    std::uint64_t total = 0;
    for (;;) {
        const ssize_t count = read(file.get(), buffer.data(), buffer.size());
        if (count == 0) break;
        if (count < 0) {
            if (errno == EINTR) continue;
            return false;
        }
        total += static_cast<std::uint64_t>(count);
        UpdateSha256(hash, buffer.data(), static_cast<std::size_t>(count));
    }
    struct stat after {};
    if (fstat(file.get(), &after) != 0 || before.st_dev != after.st_dev || before.st_ino != after.st_ino ||
        before.st_size != after.st_size || total != static_cast<std::uint64_t>(after.st_size)) {
        return false;
    }
    receipt.helper_identity = IdentityFromStat(after);
    receipt.helper_sha256 = FinishSha256(hash);
    return true;
}

[[nodiscard]] bool ReadSelfIdentityAndHash(Receipt& receipt) {
    FileDescriptor self(open("/proc/self/exe", O_RDONLY | O_CLOEXEC));
    return self.valid() && ReadDescriptorIdentityAndHash(self, receipt);
}

[[nodiscard]] FileDescriptor OpenRootDirectory(const std::string& root_path, Receipt& receipt, Failure& failure) {
    FileDescriptor slash(open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC));
    if (!slash.valid()) {
        failure = FailureFromErrno(errno, Failure::parent_open_failed);
        return {};
    }
    FileDescriptor root(OpenAt2(slash.get(), root_path == "/" ? "." : root_path.substr(1).c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC));
    if (!root.valid()) {
        failure = FailureFromErrno(errno, Failure::parent_open_failed);
        return {};
    }
    struct stat value {};
    if (fstat(root.get(), &value) != 0 || !S_ISDIR(value.st_mode)) {
        failure = FailureFromErrno(errno, Failure::wrong_entry_type);
        return {};
    }
    receipt.parent_before = IdentityFromStat(value);
    return root;
}

[[nodiscard]] bool RevalidateParent(
    const std::string& root_path,
    const Identity& expected,
    Identity& observed,
    Failure& failure) {
    FileDescriptor slash(open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC));
    FileDescriptor root(
        slash.valid()
            ? OpenAt2(slash.get(), root_path == "/" ? "." : root_path.substr(1).c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC)
            : -1);
    struct stat value {};
    if (!root.valid() || fstat(root.get(), &value) != 0 || !S_ISDIR(value.st_mode)) {
        failure = FailureFromErrno(errno, Failure::parent_open_failed);
        return false;
    }
    observed = IdentityFromStat(value);
    if (!SameIdentity(expected, observed)) {
        failure = Failure::identity_changed;
        return false;
    }
    return true;
}

// A complete prepared directory moves as one entry. RENAME_NOREPLACE owns the
// destination condition; an earlier userspace absence check cannot provide it.
// Applied uncertainty is retained by the caller's journal, never undone here.
[[nodiscard]] Receipt PublishEntry(
    const Request& request,
    Receipt receipt,
    const int source_parent,
    const std::string& source_name) {
    Failure failure = Failure::none;
    std::string destination(
        reinterpret_cast<const char*>(request.payload.value.data()), request.payload.value.size());
    const ScopedMemoryZero destination_zero(destination.data(), destination.size());
    if (!IsCanonicalAbsolutePath(destination, false) || destination == request.target_path) {
        receipt.failure = Failure::invalid_path;
        return receipt;
    }
    const std::size_t delimiter = destination.rfind('/');
    if (delimiter == std::string::npos) {
        receipt.failure = Failure::invalid_path;
        return receipt;
    }
    const std::string destination_parent_path = delimiter == 0 ? "/" : destination.substr(0, delimiter);
    const std::string destination_name = destination.substr(delimiter + 1U);
    Receipt destination_receipt;
    FileDescriptor destination_parent = OpenRootDirectory(destination_parent_path, destination_receipt, failure);
    if (!destination_parent.valid()) {
        receipt.failure = failure;
        return receipt;
    }
    if (!SameIdentity(receipt.parent_before, request.expected_source_parent) ||
        !SameIdentity(destination_receipt.parent_before, request.expected_destination_parent)) {
        receipt.failure = Failure::identity_changed;
        return receipt;
    }
    Identity source{};
    if (!ReadPublicationIdentity(source_parent, source_name, request.operation, source, failure) ||
        !SameIdentity(source, request.expected_identity)) {
        receipt.failure = failure == Failure::none ? Failure::identity_changed : failure;
        return receipt;
    }
    receipt.target_before = source;
    Identity source_parent_now{}, destination_parent_now{};
    if (!RevalidateParent(request.root_path, receipt.parent_before, source_parent_now, failure) ||
        !RevalidateParent(destination_parent_path, destination_receipt.parent_before, destination_parent_now, failure)) {
        receipt.failure = failure;
        return receipt;
    }
#if defined(OAAM_WSL_FILE_MUTATION_TEST_FAULTS)
    if (request.test_fault == TestFault::directory_pause_before_publish) {
        const std::string marker = source_name + ".oaam-publish-ready";
        FileDescriptor ready(OpenAt2(source_parent, marker.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600));
        if (!ready.valid() || fsync(ready.get()) != 0 || fsync(source_parent) != 0) {
            receipt.failure = Failure::io_error;
            return receipt;
        }
        for (;;) static_cast<void>(pause());
    }
    if (request.test_fault == TestFault::directory_target_race &&
        mkdirat(destination_parent.get(), destination_name.c_str(), 0700) != 0) {
        receipt.failure = Failure::io_error;
        return receipt;
    }
    if (request.test_fault == TestFault::directory_source_race) {
        const std::string displaced = source_name + ".oaam-source-race";
        if (syscall(SYS_renameat2, source_parent, source_name.c_str(), source_parent,
                    displaced.c_str(), RENAME_NOREPLACE) != 0 ||
            mkdirat(source_parent, source_name.c_str(), 0700) != 0) {
            receipt.failure = Failure::io_error;
            return receipt;
        }
    }
    if (request.test_fault == TestFault::rename) {
        receipt.failure = Failure::rename_failed;
        return receipt;
    }
#endif
    if (syscall(SYS_renameat2, source_parent, source_name.c_str(), destination_parent.get(),
                destination_name.c_str(), RENAME_NOREPLACE) != 0) {
        receipt.failure = FailureFromErrno(errno, errno == EEXIST ? Failure::target_conflict : Failure::rename_failed);
        return receipt;
    }
    receipt.certainty = Certainty::may_have_applied;
#if defined(OAAM_WSL_FILE_MUTATION_TEST_FAULTS)
    if (request.test_fault == TestFault::parent_fsync) {
        receipt.failure = Failure::parent_fsync_failed;
        return receipt;
    }
#endif
    if (fsync(source_parent) != 0 || fsync(destination_parent.get()) != 0) {
        receipt.failure = Failure::parent_fsync_failed;
        return receipt;
    }
    Identity published{};
    if (!RevalidateParent(request.root_path, receipt.parent_before, source_parent_now, failure) ||
        !RevalidateParent(destination_parent_path, destination_receipt.parent_before, destination_parent_now, failure) ||
        !ReadPublicationIdentity(destination_parent.get(), destination_name, request.operation, published, failure) ||
        !SameIdentity(source, published)) {
        receipt.failure = failure == Failure::none ? Failure::identity_changed : failure;
        return receipt;
    }
#if defined(OAAM_WSL_FILE_MUTATION_TEST_FAULTS)
    if (request.test_fault == TestFault::readback) {
        receipt.failure = Failure::readback_failed;
        return receipt;
    }
#endif
    receipt.parent_after = source_parent_now;
    receipt.target_after = published;
    receipt.status = Status::complete;
    receipt.certainty = Certainty::applied_verified;
    receipt.failure = Failure::none;
    return receipt;
}

[[nodiscard]] Receipt Mutate(const Request& request) {
    Receipt receipt;
    receipt.operation = request.operation;
    receipt.nonce = request.nonce;
    receipt.byte_size = request.payload.value.size();
    receipt.content_sha256 = HashBytes(request.payload.value);
    Failure failure = Failure::none;
#if defined(OAAM_WSL_FILE_MUTATION_TEST_FAULTS)
    if (request.test_fault == TestFault::unsupported_architecture) {
        receipt.failure = Failure::unsupported_architecture;
        return receipt;
    }
#endif
    if (!ReadSelfIdentityAndHash(receipt)) {
        receipt.failure = Failure::io_error;
        return receipt;
    }
    FileDescriptor parent = OpenRootDirectory(request.root_path, receipt, failure);
    if (!parent.valid()) {
        receipt.failure = failure;
        return receipt;
    }
    const std::string name = request.target_path.substr(request.target_path.rfind('/') + 1U);
    if (name.empty() || name.find('/') != std::string::npos) {
        receipt.failure = Failure::invalid_path;
        return receipt;
    }
    return PublishEntry(request, receipt, parent.get(), name);
}


[[nodiscard]] bool SupportedArchitecture() {
    struct utsname value {};
    return uname(&value) == 0 && std::string_view(value.machine) == "x86_64";
}

[[nodiscard]] bool ParsePositiveInteger(const std::string_view text, std::uint64_t& output) {
    const auto parsed = std::from_chars(text.data(), text.data() + text.size(), output);
    return parsed.ec == std::errc{} && parsed.ptr == text.data() + text.size() && output != 0;
}

[[nodiscard]] bool ReadProcessBirth(const std::uint64_t process_id, std::uint64_t& birth) {
    const std::string stat_path = "/proc/" + std::to_string(process_id) + "/stat";
    FileDescriptor file(open(stat_path.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW));
    if (!file.valid()) return false;
    std::array<char, 8192> buffer{};
    const ssize_t count = read(file.get(), buffer.data(), buffer.size());
    if (count <= 0 || static_cast<std::size_t>(count) >= buffer.size()) return false;
    const std::string_view stat(buffer.data(), static_cast<std::size_t>(count));
    const std::size_t end_name = stat.rfind(") ");
    if (end_name == std::string_view::npos) return false;
    std::string_view fields = stat.substr(end_name + 2U);
    for (std::size_t index = 0; index < 19U; ++index) {
        const std::size_t space = fields.find(' ');
        if (space == std::string_view::npos) return false;
        fields.remove_prefix(space + 1U);
    }
    return ParsePositiveInteger(fields.substr(0, fields.find(' ')), birth);
}

[[nodiscard]] bool BindOwnedParent(const int argc, char* argv[]) {
    // Bind the exact live Linux parent before reading any publication input.
    if (argc != 4 || std::string_view(argv[1]) != "--owned-parent") return false;
    std::uint64_t parent = 0, expected_birth = 0, before = 0, after = 0;
    if (!ParsePositiveInteger(argv[2], parent) || !ParsePositiveInteger(argv[3], expected_birth) ||
        parent != static_cast<std::uint64_t>(getppid()) ||
        !ReadProcessBirth(parent, before) || before != expected_birth ||
        prctl(PR_SET_PDEATHSIG, SIGKILL) != 0 ||
        parent != static_cast<std::uint64_t>(getppid()) ||
        !ReadProcessBirth(parent, after) || after != expected_birth) return false;
    return true;
}

}  // namespace

int main(const int argc, char* argv[]) {
    if (!BindOwnedParent(argc, argv)) return 121;
    Receipt receipt;
    if (!ReadSelfIdentityAndHash(receipt)) {
        receipt.failure = Failure::io_error;
        return EmitReceipt(receipt) ? 0 : 120;
    }
    if (!SupportedArchitecture()) {
        receipt.failure = Failure::unsupported_architecture;
        return EmitReceipt(receipt) ? 0 : 120;
    }
    std::array<std::uint8_t, 8> magic{};
    if (!ReadExact(STDIN_FILENO, magic.data(), magic.size())) {
        receipt.failure = Failure::invalid_frame;
        return EmitReceipt(receipt) ? 0 : 120;
    }
    Request request;
    Failure failure = Failure::none;
    if (!ParseRequest(magic, request, failure)) {
        receipt.operation = request.operation;
        receipt.nonce = request.nonce;
        receipt.failure = failure;
        return EmitReceipt(receipt) ? 0 : 120;
    }
    receipt = Mutate(request);
    return EmitReceipt(receipt) ? 0 : 120;
}
