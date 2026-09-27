#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc < 2) {
    fputs("Kova resource owner requires a command\n", stderr);
    return 64;
  }
  if (prctl(PR_SET_CHILD_SUBREAPER, 1) == -1) {
    fprintf(stderr, "Kova could not claim Linux child ownership: %s\n", strerror(errno));
    return 70;
  }
  // Adopted zombies retain the wait counters used by Kova's terminal census.
  // The command timeout bounds this owner; its exit hands final reaping to init.
  execvp(argv[1], &argv[1]);
  fprintf(stderr, "Kova could not start its resource helper: %s\n", strerror(errno));
  return errno == ENOENT ? 127 : 126;
}
