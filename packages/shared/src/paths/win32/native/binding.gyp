{
    "targets": [
        {
            "target_name": "oaam_windows_filesystem",
            "sources": [
                "src/addon.cc",
                "src/native-errors.cc",
                "src/process-invocation.cc",
                "src/process-observation.cc",
                "src/recycle-bin.cc",
                "src/safe-mutation.cc",
                "src/safe-read.cc"
            ],
            "defines": [
                "NAPI_VERSION=10",
                "NOMINMAX",
                "UNICODE",
                "_UNICODE",
                "WIN32_LEAN_AND_MEAN",
                "_WIN32_WINNT=0x0A00",
                "WINVER=0x0A00"
            ],
            "msvs_settings": {
                "VCCLCompilerTool": {
                    "AdditionalOptions": [
                        "/permissive-",
                        "/std:c++20",
                        "/W4",
                        "/WX",
                        "/sdl",
                        "/guard:cf"
                    ],
                    "ExceptionHandling": 1
                },
                "VCLinkerTool": {
                    "AdditionalOptions": [
                        "/guard:cf"
                    ]
                }
            },
            "libraries": [
                "ole32.lib",
                "shell32.lib"
            ]
        }
    ]
}
