#include "process-invocation.h"

#include "native-errors.h"

#include <windows.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <optional>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace oaam::win32 {
namespace {

constexpr std::uint32_t kTerminationGraceMilliseconds = 200;
constexpr std::uint32_t kPollingMilliseconds = 5;
constexpr std::size_t kPipeChunkBytes = 16U * 1024U;
constexpr DWORD kOutputPipeBufferBytes = 64U * 1024U;
constexpr std::size_t kMaximumObservedProcesses = 65'536U;
constexpr std::size_t kMaximumEnvironmentBytes = 256U * 1024U;

void SecureClearBytes(std::vector<std::uint8_t>& bytes) {
    if (!bytes.empty()) {
        SecureZeroMemory(bytes.data(), bytes.size());
        bytes.clear();
    }
}

class AttributeListOwner final {
  public:
    explicit AttributeListOwner(
        const std::array<HANDLE, 3>& inherited_handles) {
        SIZE_T bytes = 0;
        static_cast<void>(
            InitializeProcThreadAttributeList(nullptr, 1, 0, &bytes));
        if (bytes == 0) {
            ThrowWin32(
                GetLastError(),
                "could not size the OAAM-owned process attribute list");
        }
        storage_.resize(bytes);
        value_ = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(
            storage_.data());
        if (InitializeProcThreadAttributeList(value_, 1, 0, &bytes) == FALSE) {
            ThrowWin32(
                GetLastError(),
                "could not initialize the OAAM-owned process attribute list");
        }
        initialized_ = true;
        if (UpdateProcThreadAttribute(
                value_,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                const_cast<HANDLE*>(inherited_handles.data()),
                sizeof(HANDLE) * inherited_handles.size(),
                nullptr,
                nullptr) == FALSE) {
            ThrowWin32(
                GetLastError(),
                "could not restrict OAAM-owned process handle inheritance");
        }
    }

    ~AttributeListOwner() {
        if (initialized_) {
            DeleteProcThreadAttributeList(value_);
        }
    }

    AttributeListOwner(const AttributeListOwner&) = delete;
    AttributeListOwner& operator=(const AttributeListOwner&) = delete;
    AttributeListOwner(AttributeListOwner&&) = delete;
    AttributeListOwner& operator=(AttributeListOwner&&) = delete;

    [[nodiscard]] LPPROC_THREAD_ATTRIBUTE_LIST get() noexcept {
        return value_;
    }

  private:
    std::vector<std::byte> storage_;
    LPPROC_THREAD_ATTRIBUTE_LIST value_ = nullptr;
    bool initialized_ = false;
};

[[nodiscard]] std::uint64_t FileTimeValue(const FILETIME& value) noexcept {
    ULARGE_INTEGER result{};
    result.LowPart = value.dwLowDateTime;
    result.HighPart = value.dwHighDateTime;
    return result.QuadPart;
}

[[nodiscard]] std::string LifecycleToken(HANDLE process) {
    FILETIME created{};
    FILETIME exited{};
    FILETIME kernel{};
    FILETIME user{};
    if (GetProcessTimes(process, &created, &exited, &kernel, &user) == FALSE) {
        ThrowWin32(GetLastError(), "could not read an OAAM-owned process lifecycle");
    }
    return std::to_string(FileTimeValue(created));
}

[[nodiscard]] std::wstring QuoteArgument(const std::wstring& value) {
    if (!value.empty() &&
        value.find_first_of(L" \t\n\v\"") == std::wstring::npos) {
        return value;
    }
    std::wstring quoted = L"\"";
    std::size_t backslashes = 0;
    for (const wchar_t character : value) {
        if (character == L'\\') {
            ++backslashes;
            continue;
        }
        if (character == L'"') {
            quoted.append(backslashes * 2U + 1U, L'\\');
            quoted.push_back(L'"');
            backslashes = 0;
            continue;
        }
        quoted.append(backslashes, L'\\');
        backslashes = 0;
        quoted.push_back(character);
    }
    quoted.append(backslashes * 2U, L'\\');
    quoted.push_back(L'"');
    return quoted;
}

[[nodiscard]] std::vector<wchar_t> BuildCommandLine(
    const std::wstring& executable_path,
    const std::vector<std::wstring>& arguments) {
    std::wstring command_line = QuoteArgument(executable_path);
    for (const std::wstring& argument : arguments) {
        command_line.push_back(L' ');
        command_line.append(QuoteArgument(argument));
    }
    command_line.push_back(L'\0');
    return std::vector<wchar_t>(command_line.begin(), command_line.end());
}

[[nodiscard]] std::vector<wchar_t> BuildEnvironment(
    const std::vector<std::pair<std::wstring, std::wstring>>& entries,
    const std::wstring& invocation_token) {
    std::vector<std::pair<std::wstring, std::wstring>> environment = entries;
    environment.emplace_back(L"OAAM_INVOCATION_TOKEN", invocation_token);
    std::sort(
        environment.begin(),
        environment.end(),
        [](const auto& left, const auto& right) {
            return CompareStringOrdinal(
                       left.first.c_str(),
                       static_cast<int>(left.first.size()),
                       right.first.c_str(),
                       static_cast<int>(right.first.size()),
                       TRUE) == CSTR_LESS_THAN;
        });
    std::size_t characters = 1U;
    for (const auto& [name, value] : environment) {
        characters += name.size() + 1U + value.size() + 1U;
    }
    if (characters > kMaximumEnvironmentBytes / sizeof(wchar_t)) {
        ThrowResourceLimit("Windows invocation environment exceeds the reviewed bound");
    }
    std::vector<wchar_t> block;
    block.reserve(characters);
    for (const auto& [name, value] : environment) {
        block.insert(block.end(), name.begin(), name.end());
        block.push_back(L'=');
        block.insert(block.end(), value.begin(), value.end());
        block.push_back(L'\0');
    }
    block.push_back(L'\0');
    return block;
}

[[nodiscard]] detail::UniqueHandle CreatePipeRead(
    detail::UniqueHandle& write_handle) {
    SECURITY_ATTRIBUTES security{};
    security.nLength = sizeof(security);
    security.bInheritHandle = TRUE;
    HANDLE read_raw = INVALID_HANDLE_VALUE;
    HANDLE write_raw = INVALID_HANDLE_VALUE;
    if (CreatePipe(
            &read_raw,
            &write_raw,
            &security,
            kOutputPipeBufferBytes) == FALSE) {
        ThrowWin32(GetLastError(), "could not create an OAAM-owned output pipe");
    }
    detail::UniqueHandle read(read_raw);
    write_handle.reset(write_raw);
    if (SetHandleInformation(read.get(), HANDLE_FLAG_INHERIT, 0) == FALSE) {
        ThrowWin32(GetLastError(), "could not protect an OAAM-owned output pipe");
    }
    return read;
}

[[nodiscard]] detail::UniqueHandle CreateNullInput() {
    detail::UniqueHandle input(
        CreateFileW(
            L"NUL",
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            nullptr,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            nullptr));
    if (!input.valid()) {
        ThrowWin32(GetLastError(), "could not open the null input device");
    }
    if (SetHandleInformation(input.get(), HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) == FALSE) {
        ThrowWin32(GetLastError(), "could not prepare the null input handle");
    }
    return input;
}

[[nodiscard]] detail::UniqueHandle CreateOwnedJob() {
    detail::UniqueHandle job(CreateJobObjectW(nullptr, nullptr));
    if (!job.valid()) {
        ThrowWin32(GetLastError(), "could not create an OAAM-owned process job");
    }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
        JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
    if (SetInformationJobObject(
            job.get(),
            JobObjectExtendedLimitInformation,
            &limits,
            sizeof(limits)) == FALSE) {
        ThrowWin32(GetLastError(), "could not constrain an OAAM-owned process job");
    }
    return job;
}

[[nodiscard]] std::vector<std::uint32_t> QueryJobProcessIds(HANDLE job) {
    std::size_t capacity = 32U;
    for (;;) {
        const std::size_t bytes =
            sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) +
            (capacity - 1U) * sizeof(ULONG_PTR);
        std::vector<std::byte> buffer(bytes);
        auto* list =
            reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(buffer.data());
        if (QueryInformationJobObject(
                job,
                JobObjectBasicProcessIdList,
                list,
                static_cast<DWORD>(buffer.size()),
                nullptr) != FALSE) {
            if (list->NumberOfAssignedProcesses > kMaximumObservedProcesses) {
                ThrowResourceLimit("OAAM-owned process job exceeds the reviewed process bound");
            }
            if (list->NumberOfProcessIdsInList <
                list->NumberOfAssignedProcesses) {
                capacity = static_cast<std::size_t>(
                    list->NumberOfAssignedProcesses);
                continue;
            }
            std::vector<std::uint32_t> process_ids;
            process_ids.reserve(list->NumberOfProcessIdsInList);
            for (DWORD index = 0; index < list->NumberOfProcessIdsInList; ++index) {
                const ULONG_PTR value = list->ProcessIdList[index];
                if (value == 0 ||
                    value > std::numeric_limits<std::uint32_t>::max()) {
                    ThrowStale("OAAM-owned process job returned an invalid PID");
                }
                process_ids.push_back(static_cast<std::uint32_t>(value));
            }
            std::sort(process_ids.begin(), process_ids.end());
            process_ids.erase(
                std::unique(process_ids.begin(), process_ids.end()),
                process_ids.end());
            return process_ids;
        }
        const DWORD error = GetLastError();
        if (error != ERROR_MORE_DATA) {
            ThrowWin32(error, "could not inspect an OAAM-owned process job");
        }
        capacity *= 2U;
        if (capacity > kMaximumObservedProcesses) {
            ThrowResourceLimit("OAAM-owned process job exceeds the reviewed process bound");
        }
    }
}

void ObserveJobProcesses(
    HANDLE job,
    std::vector<NativeOwnedInvocationProcessIdentity>& observed) {
    for (const std::uint32_t process_id : QueryJobProcessIds(job)) {
        const auto existing = std::find_if(
            observed.begin(),
            observed.end(),
            [process_id](const auto& item) {
                return item.process_id == process_id;
            });
        if (existing != observed.end()) {
            continue;
        }
        detail::UniqueHandle process(
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                FALSE,
                process_id));
        if (!process.valid()) {
            const DWORD error = GetLastError();
            if (error == ERROR_INVALID_PARAMETER) {
                continue;
            }
            ThrowWin32(error, "could not bind an OAAM-owned descendant lifecycle");
        }
        observed.push_back(
            NativeOwnedInvocationProcessIdentity{
                process_id,
                LifecycleToken(process.get())});
    }
}

[[nodiscard]] bool JobIsEmpty(HANDLE job) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information{};
    if (QueryInformationJobObject(
            job,
            JobObjectBasicAccountingInformation,
            &information,
            sizeof(information),
            nullptr) == FALSE) {
        ThrowWin32(GetLastError(), "could not inspect OAAM-owned job accounting");
    }
    return information.ActiveProcesses == 0;
}

[[nodiscard]] bool DrainPipe(
    HANDLE pipe,
    std::vector<std::uint8_t>& destination,
    std::uint64_t& total_output,
    const std::uint64_t maximum_output,
    bool& output_limit_exceeded) {
    bool made_progress = false;
    for (;;) {
        DWORD available = 0;
        if (PeekNamedPipe(
                pipe,
                nullptr,
                0,
                nullptr,
                &available,
                nullptr) == FALSE) {
            const DWORD error = GetLastError();
            if (error == ERROR_BROKEN_PIPE) {
                return made_progress;
            }
            ThrowWin32(error, "could not inspect an OAAM-owned output pipe");
        }
        if (available == 0) {
            return made_progress;
        }
        const DWORD requested =
            std::min<DWORD>(available, static_cast<DWORD>(kPipeChunkBytes));
        std::array<std::uint8_t, kPipeChunkBytes> buffer{};
        DWORD read = 0;
        if (ReadFile(
                pipe,
                buffer.data(),
                requested,
                &read,
                nullptr) == FALSE) {
            const DWORD error = GetLastError();
            if (error == ERROR_BROKEN_PIPE) {
                return made_progress;
            }
            ThrowWin32(error, "could not read an OAAM-owned output pipe");
        }
        total_output += read;
        made_progress = true;
        if (total_output > maximum_output) {
            output_limit_exceeded = true;
            continue;
        }
        destination.insert(
            destination.end(),
            buffer.begin(),
            buffer.begin() + read);
    }
}

[[nodiscard]] bool SameLifecycle(
    const NativeOwnedInvocationProcessIdentity& identity) {
    detail::UniqueHandle process(
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION,
            FALSE,
            identity.process_id));
    if (!process.valid()) {
        return GetLastError() != ERROR_INVALID_PARAMETER;
    }
    DWORD exit_code = STILL_ACTIVE;
    if (GetExitCodeProcess(process.get(), &exit_code) == FALSE) {
        return true;
    }
    if (exit_code != STILL_ACTIVE) {
        return false;
    }
    return LifecycleToken(process.get()) == identity.lifecycle_token;
}

[[nodiscard]] bool AllObservedProcessesAbsent(
    const std::vector<NativeOwnedInvocationProcessIdentity>& observed) {
    return std::none_of(
        observed.begin(),
        observed.end(),
        [](const auto& identity) {
            return SameLifecycle(identity);
        });
}

void AttemptGracefulTermination(const std::uint32_t process_group_id) noexcept {
    static_cast<void>(
        GenerateConsoleCtrlEvent(
            CTRL_BREAK_EVENT,
            process_group_id));
}

[[nodiscard]] std::chrono::steady_clock::time_point DeadlineAfter(
    const std::uint32_t milliseconds) {
    return std::chrono::steady_clock::now() +
           std::chrono::milliseconds(milliseconds);
}

void WaitAndObserve(
    HANDLE job,
    HANDLE stdout_pipe,
    HANDLE stderr_pipe,
    std::vector<NativeOwnedInvocationProcessIdentity>& observed,
    std::vector<std::uint8_t>& stdout_bytes,
    std::vector<std::uint8_t>& stderr_bytes,
    std::uint64_t& total_output,
    const std::uint64_t maximum_output,
    bool& output_limit_exceeded,
    const std::chrono::steady_clock::time_point deadline) {
    while (std::chrono::steady_clock::now() < deadline) {
        ObserveJobProcesses(job, observed);
        const bool stdout_progress = DrainPipe(
            stdout_pipe,
            stdout_bytes,
            total_output,
            maximum_output,
            output_limit_exceeded);
        const bool stderr_progress = DrainPipe(
            stderr_pipe,
            stderr_bytes,
            total_output,
            maximum_output,
            output_limit_exceeded);
        if (JobIsEmpty(job) || output_limit_exceeded) {
            return;
        }
        if (!stdout_progress && !stderr_progress) {
            std::this_thread::sleep_for(
                std::chrono::milliseconds(kPollingMilliseconds));
        }
    }
}

struct ProcessTreeState {
    detail::UniqueHandle job;
    detail::UniqueHandle process;
    detail::UniqueHandle thread;
    detail::UniqueHandle stdout_read;
    detail::UniqueHandle stderr_read;
    NativeOwnedInvocationProcessIdentity root_process{};
    std::vector<NativeOwnedInvocationProcessIdentity> observed_processes;
    std::vector<std::uint8_t> stdout_bytes;
    std::vector<std::uint8_t> stderr_bytes;
    std::uint64_t total_output = 0;
    std::uint64_t maximum_output = 0;
    bool output_limit_exceeded = false;
};

[[nodiscard]] ProcessTreeState LaunchProcessTreeSuspended(
    const std::wstring& executable_path,
    const std::vector<std::wstring>& arguments,
    const std::wstring& working_directory,
    const std::vector<std::pair<std::wstring, std::wstring>>& environment_entries,
    const std::wstring& invocation_token,
    const std::uint64_t maximum_output) {
    detail::UniqueHandle stdout_write;
    detail::UniqueHandle stderr_write;
    detail::UniqueHandle stdout_read = CreatePipeRead(stdout_write);
    detail::UniqueHandle stderr_read = CreatePipeRead(stderr_write);
    detail::UniqueHandle stdin_child = CreateNullInput();
    const std::array<HANDLE, 3> inherited_handles{
        stdin_child.get(),
        stdout_write.get(),
        stderr_write.get()};
    AttributeListOwner attributes(inherited_handles);
    detail::UniqueHandle job = CreateOwnedJob();
    std::vector<wchar_t> command_line =
        BuildCommandLine(executable_path, arguments);
    std::vector<wchar_t> environment =
        BuildEnvironment(environment_entries, invocation_token);

    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = stdin_child.get();
    startup.StartupInfo.hStdOutput = stdout_write.get();
    startup.StartupInfo.hStdError = stderr_write.get();
    startup.lpAttributeList = attributes.get();
    PROCESS_INFORMATION information{};
    const DWORD creation_flags =
        CREATE_SUSPENDED |
        CREATE_UNICODE_ENVIRONMENT |
        CREATE_NO_WINDOW |
        CREATE_NEW_PROCESS_GROUP |
        EXTENDED_STARTUPINFO_PRESENT;
    if (CreateProcessW(
            executable_path.c_str(),
            command_line.data(),
            nullptr,
            nullptr,
            TRUE,
            creation_flags,
            environment.data(),
            working_directory.c_str(),
            &startup.StartupInfo,
            &information) == FALSE) {
        ThrowWin32(GetLastError(), "could not create the exact OAAM-owned executable");
    }
    detail::UniqueHandle process(information.hProcess);
    detail::UniqueHandle thread(information.hThread);
    if (AssignProcessToJobObject(job.get(), process.get()) == FALSE) {
        const DWORD error = GetLastError();
        static_cast<void>(TerminateProcess(process.get(), 1));
        ThrowWin32(error, "could not bind the exact executable to the OAAM-owned job");
    }
    const NativeOwnedInvocationProcessIdentity root{
        information.dwProcessId,
        LifecycleToken(process.get())};
    ProcessTreeState state{};
    state.job = std::move(job);
    state.process = std::move(process);
    state.thread = std::move(thread);
    state.stdout_read = std::move(stdout_read);
    state.stderr_read = std::move(stderr_read);
    state.root_process = root;
    state.observed_processes.push_back(root);
    state.maximum_output = maximum_output;
    return state;
}

void ResumeProcessTree(ProcessTreeState& state) {
    if (!state.thread.valid()) {
        ThrowStale("OAAM-owned executable has already been resumed");
    }
    if (ResumeThread(state.thread.get()) == std::numeric_limits<DWORD>::max()) {
        const DWORD error = GetLastError();
        static_cast<void>(TerminateJobObject(state.job.get(), 1));
        ThrowWin32(error, "could not start the OAAM-owned executable");
    }
    state.thread.reset();
}

bool ObserveProcessTree(ProcessTreeState& state) {
    ObserveJobProcesses(state.job.get(), state.observed_processes);
    const bool stdout_progress = DrainPipe(
        state.stdout_read.get(),
        state.stdout_bytes,
        state.total_output,
        state.maximum_output,
        state.output_limit_exceeded);
    const bool stderr_progress = DrainPipe(
        state.stderr_read.get(),
        state.stderr_bytes,
        state.total_output,
        state.maximum_output,
        state.output_limit_exceeded);
    return stdout_progress || stderr_progress;
}

[[nodiscard]] NativeLocalExecutableTreeInvocationResult FinalizeProcessTree(
    ProcessTreeState& state,
    const bool completed_before_deadline) {
    if (!JobIsEmpty(state.job.get())) {
        AttemptGracefulTermination(state.root_process.process_id);
        WaitAndObserve(
            state.job.get(),
            state.stdout_read.get(),
            state.stderr_read.get(),
            state.observed_processes,
            state.stdout_bytes,
            state.stderr_bytes,
            state.total_output,
            state.maximum_output,
            state.output_limit_exceeded,
            DeadlineAfter(kTerminationGraceMilliseconds));
    }
    if (!JobIsEmpty(state.job.get())) {
        if (TerminateJobObject(state.job.get(), 1) == FALSE) {
            ThrowWin32(GetLastError(), "could not terminate the OAAM-owned process job");
        }
        WaitAndObserve(
            state.job.get(),
            state.stdout_read.get(),
            state.stderr_read.get(),
            state.observed_processes,
            state.stdout_bytes,
            state.stderr_bytes,
            state.total_output,
            state.maximum_output,
            state.output_limit_exceeded,
            DeadlineAfter(kTerminationGraceMilliseconds));
    }
    ObserveProcessTree(state);

    const bool job_empty = JobIsEmpty(state.job.get());
    const bool observed_absent =
        AllObservedProcessesAbsent(state.observed_processes);
    DWORD exit_code = STILL_ACTIVE;
    if (GetExitCodeProcess(state.process.get(), &exit_code) == FALSE) {
        ThrowWin32(GetLastError(), "could not read the OAAM-owned process exit code");
    }
    const bool root_exited = exit_code != STILL_ACTIVE;
    const bool cleanup_complete =
        job_empty && observed_absent && root_exited;
    std::sort(
        state.observed_processes.begin(),
        state.observed_processes.end(),
        [](const auto& left, const auto& right) {
            return left.process_id < right.process_id;
        });

    std::string status;
    std::string failure_code;
    if (!cleanup_complete) {
        status = "cleanup_failed";
        failure_code = "process_tree_remains";
    } else if (state.output_limit_exceeded) {
        status = "failed";
        failure_code = "output_limit";
    } else if (!completed_before_deadline) {
        status = "timed_out";
        failure_code = "timeout";
    } else if (exit_code != 0) {
        status = "failed";
        failure_code = "exit";
    } else {
        status = "complete";
    }
    if (status != "complete") {
        SecureClearBytes(state.stdout_bytes);
    }
    const bool retain_natural_exit_stderr =
        status == "failed" &&
        failure_code == "exit" &&
        completed_before_deadline &&
        cleanup_complete &&
        exit_code != 0;
    if (status != "complete" && !retain_natural_exit_stderr) {
        SecureClearBytes(state.stderr_bytes);
    }
    return NativeLocalExecutableTreeInvocationResult{
        status,
        root_exited ? std::optional<std::uint32_t>(exit_code) : std::nullopt,
        std::move(state.stdout_bytes),
        std::move(state.stderr_bytes),
        state.root_process,
        std::move(state.observed_processes),
        cleanup_complete,
        cleanup_complete,
        failure_code};
}

}  // namespace

NativeLocalExecutableTreeInvocationResult
InvokeLocalExecutableTreeBounded(
    const std::wstring& executable_path,
    const PhysicalIdentity& expected_executable_identity,
    const std::vector<std::wstring>& arguments,
    const std::wstring& working_directory,
    const std::vector<std::pair<std::wstring, std::wstring>>& environment_entries,
    const std::wstring& invocation_token,
    const std::uint32_t timeout_milliseconds,
    const std::uint64_t maximum_output_bytes) {
    detail::UniqueHandle executable =
        detail::OpenCanonicalPath(
            executable_path,
            EntryKind::file,
            FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_SHARE_READ);
    if (!detail::SameIdentity(
            detail::QueryStableSample(executable.get()).identity,
            expected_executable_identity)) {
        ThrowStale("selected executable identity changed before invocation");
    }
    detail::UniqueHandle working_directory_handle =
        detail::OpenCanonicalPath(
            working_directory,
            EntryKind::directory,
            FILE_READ_ATTRIBUTES | SYNCHRONIZE);
    static_cast<void>(working_directory_handle);

    ProcessTreeState state = LaunchProcessTreeSuspended(
        executable_path,
        arguments,
        working_directory,
        environment_entries,
        invocation_token,
        maximum_output_bytes);
    ResumeProcessTree(state);
    const auto deadline = DeadlineAfter(timeout_milliseconds);
    WaitAndObserve(
        state.job.get(),
        state.stdout_read.get(),
        state.stderr_read.get(),
        state.observed_processes,
        state.stdout_bytes,
        state.stderr_bytes,
        state.total_output,
        maximum_output_bytes,
        state.output_limit_exceeded,
        deadline);
    const bool completed_before_deadline =
        JobIsEmpty(state.job.get()) && !state.output_limit_exceeded;
    NativeLocalExecutableTreeInvocationResult result =
        FinalizeProcessTree(state, completed_before_deadline);
    const PhysicalIdentity after_identity =
        detail::QueryStableSample(executable.get()).identity;
    if (!detail::SameIdentity(
            after_identity,
            expected_executable_identity)) {
        ThrowStale("selected executable identity changed during invocation");
    }
    return result;
}

}  // namespace oaam::win32
