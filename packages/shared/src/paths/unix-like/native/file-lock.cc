// Private Linux Node-API bridge: the caller retains ownership of the descriptor.
#include <node_api.h>
#include <cerrno>
#include <climits>
#include <cmath>
#include <cstring>
#include <fcntl.h>
#include <sys/file.h>

namespace {
napi_value Fail(napi_env env, const char* code, const char* message) {
    napi_throw_error(env, code, message);
    return nullptr;
}

napi_value TryAcquire(napi_env env, napi_callback_info info) {
    size_t count = 2;
    napi_value args[2];
    double value = -1;
    if (napi_get_cb_info(env, info, &count, args, nullptr, nullptr) != napi_ok || count != 1 ||
        napi_get_value_double(env, args[0], &value) != napi_ok || !std::isfinite(value) ||
        value < 0 || value > INT_MAX || std::floor(value) != value) {
        return Fail(env, "LOCK_DESCRIPTOR_INVALID", "lock descriptor must be a non-negative integer");
    }
    const int fd = static_cast<int>(value);
    const int flags = fcntl(fd, F_GETFD);
    if (flags < 0) return Fail(env, "LOCK_DESCRIPTOR_UNAVAILABLE", std::strerror(errno));
    if ((flags & FD_CLOEXEC) == 0) return Fail(env, "LOCK_DESCRIPTOR_INHERITABLE", "lock descriptor must be close-on-exec");
    const int result = flock(fd, LOCK_EX | LOCK_NB);
    if (result != 0 && errno != EAGAIN && errno != EWOULDBLOCK) {
        return Fail(env, "LOCK_ACQUIRE_FAILED", std::strerror(errno));
    }
    napi_value acquired;
    if (napi_get_boolean(env, result == 0, &acquired) != napi_ok) {
        return Fail(env, "LOCK_RESULT_FAILED", "cannot construct lock result");
    }
    return acquired;
}

napi_value Initialize(napi_env env, napi_value exports) {
    napi_value version;
    if (napi_create_string_utf8(env, "oaam.linux.file-lock.v1", NAPI_AUTO_LENGTH, &version) != napi_ok) return nullptr;
    const napi_property_descriptor properties[] = {
        {"contractVersion", nullptr, nullptr, nullptr, nullptr, version, napi_enumerable, nullptr},
        {"tryAcquire", nullptr, TryAcquire, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
    };
    if (napi_define_properties(env, exports, 2, properties) != napi_ok) return nullptr;
    return exports;
}
}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
