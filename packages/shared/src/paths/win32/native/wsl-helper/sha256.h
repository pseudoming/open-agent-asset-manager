#ifndef OAAM_WSL_FILE_MUTATION_SHA256_H_
#define OAAM_WSL_FILE_MUTATION_SHA256_H_

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <vector>

#if defined(__x86_64__) && (defined(__GNUC__) || defined(__clang__))
#include <immintrin.h>
#endif

namespace oaam::wsl_file_mutation {

struct Sha256 final {
    std::array<std::uint32_t, 8> state{
        0x6a09e667U,
        0xbb67ae85U,
        0x3c6ef372U,
        0xa54ff53aU,
        0x510e527fU,
        0x9b05688cU,
        0x1f83d9abU,
        0x5be0cd19U,
    };
    std::array<std::uint8_t, 64> block{};
    std::uint64_t total_bytes = 0;
    std::size_t block_bytes = 0;
};

constexpr std::array<std::uint32_t, 64> kSha256RoundConstants{
    0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U, 0x3956c25bU, 0x59f111f1U, 0x923f82a4U,
    0xab1c5ed5U, 0xd807aa98U, 0x12835b01U, 0x243185beU, 0x550c7dc3U, 0x72be5d74U, 0x80deb1feU,
    0x9bdc06a7U, 0xc19bf174U, 0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU, 0x2de92c6fU,
    0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU, 0x983e5152U, 0xa831c66dU, 0xb00327c8U, 0xbf597fc7U,
    0xc6e00bf3U, 0xd5a79147U, 0x06ca6351U, 0x14292967U, 0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU,
    0x53380d13U, 0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U, 0xa2bfe8a1U, 0xa81a664bU,
    0xc24b8b70U, 0xc76c51a3U, 0xd192e819U, 0xd6990624U, 0xf40e3585U, 0x106aa070U, 0x19a4c116U,
    0x1e376c08U, 0x2748774cU, 0x34b0bcb5U, 0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU, 0x682e6ff3U,
    0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U, 0x90befffaU, 0xa4506cebU, 0xbef9a3f7U,
    0xc67178f2U,
};

[[nodiscard]] constexpr std::uint32_t RotateRight(const std::uint32_t value, const unsigned bits) {
    return (value >> bits) | (value << (32U - bits));
}

inline void CompressSha256Portable(Sha256& hash, const std::uint8_t* input) {
    std::array<std::uint32_t, 64> words{};
    for (std::size_t index = 0; index < 16; ++index) {
        const std::size_t offset = index * 4U;
        words[index] =
            (static_cast<std::uint32_t>(input[offset]) << 24U) |
            (static_cast<std::uint32_t>(input[offset + 1U]) << 16U) |
            (static_cast<std::uint32_t>(input[offset + 2U]) << 8U) |
            static_cast<std::uint32_t>(input[offset + 3U]);
    }
    for (std::size_t index = 16; index < words.size(); ++index) {
        const std::uint32_t left = words[index - 15U];
        const std::uint32_t right = words[index - 2U];
        const std::uint32_t sigma0 = RotateRight(left, 7U) ^ RotateRight(left, 18U) ^ (left >> 3U);
        const std::uint32_t sigma1 = RotateRight(right, 17U) ^ RotateRight(right, 19U) ^ (right >> 10U);
        words[index] = words[index - 16U] + sigma0 + words[index - 7U] + sigma1;
    }
    std::uint32_t a = hash.state[0];
    std::uint32_t b = hash.state[1];
    std::uint32_t c = hash.state[2];
    std::uint32_t d = hash.state[3];
    std::uint32_t e = hash.state[4];
    std::uint32_t f = hash.state[5];
    std::uint32_t g = hash.state[6];
    std::uint32_t h = hash.state[7];
    for (std::size_t index = 0; index < words.size(); ++index) {
        const std::uint32_t sum1 = RotateRight(e, 6U) ^ RotateRight(e, 11U) ^ RotateRight(e, 25U);
        const std::uint32_t choice = (e & f) ^ (~e & g);
        const std::uint32_t temporary1 = h + sum1 + choice + kSha256RoundConstants[index] + words[index];
        const std::uint32_t sum0 = RotateRight(a, 2U) ^ RotateRight(a, 13U) ^ RotateRight(a, 22U);
        const std::uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
        const std::uint32_t temporary2 = sum0 + majority;
        h = g;
        g = f;
        f = e;
        e = d + temporary1;
        d = c;
        c = b;
        b = a;
        a = temporary1 + temporary2;
    }
    hash.state[0] += a;
    hash.state[1] += b;
    hash.state[2] += c;
    hash.state[3] += d;
    hash.state[4] += e;
    hash.state[5] += f;
    hash.state[6] += g;
    hash.state[7] += h;
}

#if defined(__x86_64__) && (defined(__GNUC__) || defined(__clang__))
// SHA256RNDS2 consumes CDGH/ABEF lane groups; each call computes two complete rounds.
// https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sha-extensions.html
__attribute__((target("sha,ssse3"))) inline void CompressSha256Hardware(Sha256& hash, const std::uint8_t* input) {
    std::array<std::uint32_t, 4> left{hash.state[5], hash.state[4], hash.state[1], hash.state[0]};
    std::array<std::uint32_t, 4> right{hash.state[7], hash.state[6], hash.state[3], hash.state[2]};
    __m128i abef = _mm_loadu_si128(reinterpret_cast<const __m128i*>(left.data()));
    __m128i cdgh = _mm_loadu_si128(reinterpret_cast<const __m128i*>(right.data()));
    const __m128i saved_abef = abef;
    const __m128i saved_cdgh = cdgh;
    const __m128i byte_order = _mm_set_epi8(12, 13, 14, 15, 8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3);
    __m128i messages[4];
    for (std::size_t group = 0; group < 16; ++group) {
        const std::size_t current = group % 4U;
        if (group < 4) {
            messages[current] = _mm_shuffle_epi8(
                _mm_loadu_si128(reinterpret_cast<const __m128i*>(input + group * 16U)), byte_order);
        } else {
            auto next = _mm_sha256msg1_epu32(messages[current], messages[(group + 1U) % 4U]);
            next = _mm_add_epi32(
                next, _mm_alignr_epi8(messages[(group + 3U) % 4U], messages[(group + 2U) % 4U], 4));
            messages[current] = _mm_sha256msg2_epu32(next, messages[(group + 3U) % 4U]);
        }
        const auto constants = _mm_loadu_si128(
            reinterpret_cast<const __m128i*>(kSha256RoundConstants.data() + group * 4U));
        auto rounds = _mm_add_epi32(messages[current], constants);
        cdgh = _mm_sha256rnds2_epu32(cdgh, abef, rounds);
        rounds = _mm_shuffle_epi32(rounds, 0x0E);
        abef = _mm_sha256rnds2_epu32(abef, cdgh, rounds);
    }
    _mm_storeu_si128(reinterpret_cast<__m128i*>(left.data()), _mm_add_epi32(abef, saved_abef));
    _mm_storeu_si128(reinterpret_cast<__m128i*>(right.data()), _mm_add_epi32(cdgh, saved_cdgh));
    hash.state = {left[3], left[2], right[3], right[2], left[1], left[0], right[1], right[0]};
}
#endif

[[nodiscard]] inline bool HardwareSha256Available() {
#if defined(OAAM_WSL_FILE_MUTATION_TEST_FAULTS) && defined(OAAM_WSL_SHA256_FORCE_PORTABLE)
    return false;
#elif defined(__x86_64__) && (defined(__GNUC__) || defined(__clang__))
    static const bool supported = __builtin_cpu_supports("sha") != 0 && __builtin_cpu_supports("ssse3") != 0;
    return supported;
#else
    return false;
#endif
}

inline void CompressSha256(Sha256& hash, const std::uint8_t* input) {
#if defined(__x86_64__) && (defined(__GNUC__) || defined(__clang__))
    if (HardwareSha256Available()) {
        CompressSha256Hardware(hash, input);
        return;
    }
#endif
    CompressSha256Portable(hash, input);
}

inline void UpdateSha256(Sha256& hash, const std::uint8_t* input, std::size_t bytes) {
    hash.total_bytes += bytes;
    while (bytes > 0) {
        const std::size_t available = hash.block.size() - hash.block_bytes;
        const std::size_t copied = bytes < available ? bytes : available;
        std::memcpy(hash.block.data() + hash.block_bytes, input, copied);
        hash.block_bytes += copied;
        input += copied;
        bytes -= copied;
        if (hash.block_bytes == hash.block.size()) {
            CompressSha256(hash, hash.block.data());
            hash.block_bytes = 0;
        }
    }
}

[[nodiscard]] inline std::array<std::uint8_t, 32> FinishSha256(Sha256 hash) {
    const std::uint64_t bit_length = hash.total_bytes * 8U;
    hash.block[hash.block_bytes++] = 0x80U;
    if (hash.block_bytes > 56U) {
        std::fill(hash.block.begin() + static_cast<std::ptrdiff_t>(hash.block_bytes), hash.block.end(), 0);
        CompressSha256(hash, hash.block.data());
        hash.block_bytes = 0;
    }
    std::fill(hash.block.begin() + static_cast<std::ptrdiff_t>(hash.block_bytes), hash.block.begin() + 56, 0);
    for (std::size_t index = 0; index < 8; ++index) {
        hash.block[63U - index] = static_cast<std::uint8_t>(bit_length >> (index * 8U));
    }
    CompressSha256(hash, hash.block.data());
    std::array<std::uint8_t, 32> output{};
    for (std::size_t index = 0; index < hash.state.size(); ++index) {
        output[index * 4U] = static_cast<std::uint8_t>(hash.state[index] >> 24U);
        output[index * 4U + 1U] = static_cast<std::uint8_t>(hash.state[index] >> 16U);
        output[index * 4U + 2U] = static_cast<std::uint8_t>(hash.state[index] >> 8U);
        output[index * 4U + 3U] = static_cast<std::uint8_t>(hash.state[index]);
    }
    return output;
}

[[nodiscard]] inline std::array<std::uint8_t, 32> HashBytes(const std::vector<std::uint8_t>& bytes) {
    Sha256 hash;
    UpdateSha256(hash, bytes.data(), bytes.size());
    return FinishSha256(hash);
}

}  // namespace oaam::wsl_file_mutation

#endif  // OAAM_WSL_FILE_MUTATION_SHA256_H_
