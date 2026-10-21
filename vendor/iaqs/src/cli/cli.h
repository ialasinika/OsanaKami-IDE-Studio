// iaqs command line interface.
#pragma once

namespace iaqs::cli {

// Returns the process exit code (0 ok, 1 runtime error, 2 usage, 4 bad password).
int run(int argc, char** argv);

}  // namespace iaqs::cli
