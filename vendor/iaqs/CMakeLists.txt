cmake_minimum_required(VERSION 3.20)
project(iaqs VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Debug CACHE STRING "Build type" FORCE)
endif()

if(MSVC)
  add_compile_options(/W4 /utf-8)
else()
  add_compile_options(-Wall -Wextra -Wpedantic)
endif()

# ---------------------------------------------------------------- core library
add_library(iaqs_core STATIC)
file(GLOB_RECURSE IAQS_CORE_SOURCES CONFIGURE_DEPENDS
     "${CMAKE_CURRENT_SOURCE_DIR}/src/*.cpp")
list(FILTER IAQS_CORE_SOURCES EXCLUDE REGEX "/main\\.cpp$")
target_sources(iaqs_core PRIVATE ${IAQS_CORE_SOURCES})
target_include_directories(iaqs_core PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")

if(WIN32)
  target_link_libraries(iaqs_core PRIVATE bcrypt)
endif()

# ---------------------------------------------------------------- executable
add_executable(iaqs src/main.cpp)
target_link_libraries(iaqs PRIVATE iaqs_core)
if(WIN32)
  # CommandLineToArgvW: wide command line -> UTF-8 argv (design 07 / i18n).
  target_link_libraries(iaqs PRIVATE shell32)
  # Ship a single self-contained exe: no MinGW runtime DLLs required.
  if(MINGW)
    target_link_options(iaqs PRIVATE -static -static-libgcc -static-libstdc++)
  endif()
endif()

# ---------------------------------------------------------------- tests
enable_testing()
file(GLOB_RECURSE IAQS_TEST_SOURCES CONFIGURE_DEPENDS
     "${CMAKE_CURRENT_SOURCE_DIR}/tests/*.cpp")
add_executable(iaqs_tests ${IAQS_TEST_SOURCES})
target_include_directories(iaqs_tests PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/tests")
target_link_libraries(iaqs_tests PRIVATE iaqs_core)
add_test(NAME iaqs_tests COMMAND iaqs_tests)
