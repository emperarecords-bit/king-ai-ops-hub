#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/if_alg.h>
#include <linux/fs.h>
#include <linux/capability.h>
#include <linux/magic.h>
#include <linux/mount.h>
#include <linux/openat2.h>
#include <sched.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#define MAX_PAYLOAD 262144U
#define MAX_TARGET 240U
#define EXEC_UID 10000
#define EXEC_GID 10000
#define WALL_SECONDS 10

static void result(const char *outcome, const char *code) {
  dprintf(STDOUT_FILENO, "{\"outcome\":\"%s\",\"code\":\"%s\"}\n", outcome, code);
}

static int sha256_fd(int fd, char out[65]) {
  int alg = socket(AF_ALG, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
  if (alg < 0) return -1;
  struct sockaddr_alg sa = {.salg_family = AF_ALG, .salg_type = "hash", .salg_name = "sha256"};
  if (bind(alg, (struct sockaddr *)&sa, sizeof(sa)) < 0) { close(alg); return -1; }
  int op = accept4(alg, NULL, 0, SOCK_CLOEXEC);
  close(alg);
  if (op < 0) return -1;
  if (lseek(fd, 0, SEEK_SET) < 0) { close(op); return -1; }
  char buffer[8192];
  ssize_t count;
  while ((count = read(fd, buffer, sizeof(buffer))) > 0) {
    if (send(op, buffer, (size_t)count, MSG_MORE) != count) { close(op); return -1; }
  }
  if (count < 0 || send(op, "", 0, 0) < 0) { close(op); return -1; }
  unsigned char digest[32];
  if (read(op, digest, sizeof(digest)) != (ssize_t)sizeof(digest)) { close(op); return -1; }
  close(op);
  for (size_t i = 0; i < sizeof(digest); i++) snprintf(out + (i * 2), 3, "%02x", digest[i]);
  out[64] = '\0';
  return 0;
}

static int denied_segment(const char *segment, size_t length) {
  static const char *denied[] = {"node_modules", "vendor", "dist", "build", "coverage"};
  for (size_t i = 0; i < sizeof(denied) / sizeof(denied[0]); i++) if (strlen(denied[i]) == length && !strncasecmp(segment, denied[i], length)) return 1;
  return length >= 12 && !strncmp(segment, ".king-write-", 12);
}

static int allowed_target(const char *target) {
  size_t length = strlen(target);
  if (length == 0 || length > MAX_TARGET || target[0] == '/' || target[length - 1] == '/') return 0;
  unsigned depth = 0;
  const char *segment = target;
  for (const char *cursor = target;; cursor++) {
    unsigned char c = (unsigned char)*cursor;
    if (c == '\\' || c < 0x20 || c == 0x7f) return 0;
    if (c == '/' || c == '\0') {
      unsigned char delimiter = c;
      size_t segment_length = (size_t)(cursor - segment);
      if (segment_length == 0 || segment_length > 100 || segment[0] == '.' || denied_segment(segment, segment_length) || ++depth > 12) return 0;
      for (size_t i = 0; i < segment_length; i++) {
        c = (unsigned char)segment[i];
        if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-')) return 0;
      }
      if (delimiter == '\0') break;
      segment = cursor + 1;
    }
  }
  const char *dot = strrchr(target, '.');
  if (!dot || (strcmp(dot, ".txt") && strcmp(dot, ".md") && strcmp(dot, ".json") && strcmp(dot, ".yaml") && strcmp(dot, ".yml") && strcmp(dot, ".csv"))) return 0;
  return 1;
}

static int open_parent(int root, const char *target, char leaf[101]) {
  char path[MAX_TARGET + 1];
  memcpy(path, target, strlen(target) + 1);
  char *slash = strrchr(path, '/');
  if (!slash) {
    memcpy(leaf, path, strlen(path) + 1);
    return dup(root);
  }
  *slash = '\0';
  memcpy(leaf, slash + 1, strlen(slash + 1) + 1);
  struct open_how how = {.flags = O_PATH | O_DIRECTORY | O_CLOEXEC, .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_XDEV};
  return (int)syscall(SYS_openat2, root, path, &how, sizeof(how));
}

struct utf8_state { unsigned continuations; unsigned char next_min; unsigned char next_max; };

static int valid_utf8_chunk(const unsigned char *bytes, size_t length, struct utf8_state *state) {
  for (size_t i = 0; i < length; i++) {
    unsigned char c = bytes[i];
    if (state->continuations) {
      if (c < state->next_min || c > state->next_max) return 0;
      state->continuations--;
      state->next_min = 0x80;
      state->next_max = 0xbf;
    } else if (c < 0x80) {
      if ((c < 0x20 && c != '\t' && c != '\n') || c == 0x7f) return 0;
    } else if (c >= 0xc2 && c <= 0xdf) {
      state->continuations = 1; state->next_min = 0x80; state->next_max = 0xbf;
    } else if (c >= 0xe0 && c <= 0xef) {
      state->continuations = 2;
      state->next_min = c == 0xe0 ? 0xa0 : 0x80;
      state->next_max = c == 0xed ? 0x9f : 0xbf;
    } else if (c >= 0xf0 && c <= 0xf4) {
      state->continuations = 3;
      state->next_min = c == 0xf0 ? 0x90 : 0x80;
      state->next_max = c == 0xf4 ? 0x8f : 0xbf;
    }
    else return 0;
  }
  return 1;
}

static int read_payload(int fd) {
  size_t total = 0;
  struct utf8_state utf8 = {0, 0x80, 0xbf};
  unsigned char buffer[8192];
  for (;;) {
    ssize_t count = read(STDIN_FILENO, buffer, sizeof(buffer));
    if (count < 0) return -1;
    if (count == 0) break;
    total += (size_t)count;
    if (total > MAX_PAYLOAD) { errno = EFBIG; return -1; }
    if (!valid_utf8_chunk(buffer, (size_t)count, &utf8)) { errno = EINVAL; return -1; }
    if (write(fd, buffer, (size_t)count) != count) return -1;
  }
  if (utf8.continuations) { errno = EINVAL; return -1; }
  return 0;
}

static int valid_sha256(const char *value) {
  if (!value || strlen(value) != 64) return 0;
  for (size_t i = 0; i < 64; i++) {
    unsigned char c = (unsigned char)value[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return 0;
  }
  return 1;
}

static int worker(const char *operation, const char *target, const char *expected, const char *desired, const char *workspace) {
  if (!operation || !target || !allowed_target(target)) { result("blocked", "invalid_request"); return 2; }
  if (strcmp(operation, "create") && strcmp(operation, "replace")) { result("blocked", "invalid_operation"); return 2; }
  if (!strcmp(operation, "replace") && !valid_sha256(expected)) { result("blocked", "invalid_precondition"); return 2; }
  if (!valid_sha256(desired)) { result("blocked", "invalid_desired_hash"); return 2; }
  int root = open(workspace, O_PATH | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (root < 0) { result("failed", "workspace_unavailable"); return 3; }
  char leaf[101];
  int parent = open_parent(root, target, leaf);
  close(root);
  if (parent < 0) { result("blocked", "unsafe_parent"); return 2; }

  struct stat before = {0};
  if (!strcmp(operation, "create")) {
    if (fstatat(parent, leaf, &before, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) { close(parent); result("blocked", "create_precondition_failed"); return 2; }
  } else {
    int current = openat(parent, leaf, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    char hash[65];
    if (current < 0 || fstat(current, &before) < 0 || !S_ISREG(before.st_mode) || before.st_nlink != 1 || sha256_fd(current, hash) < 0 || strcmp(hash, expected)) {
      if (current >= 0) close(current);
      close(parent);
      result("blocked", "replace_precondition_failed");
      return 2;
    }
    close(current);
  }

  char temp[96];
  snprintf(temp, sizeof(temp), ".king-write-%ld.tmp", (long)getpid());
  int staged = openat(parent, temp, O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (staged < 0) { close(parent); result("failed", "temp_create_failed"); return 3; }
  int rc = 3;
  char staged_hash[65];
  if (read_payload(staged) < 0 || fsync(staged) < 0 || sha256_fd(staged, staged_hash) < 0 || strcmp(staged_hash, desired)) { result("failed", "payload_stage_failed"); goto cleanup; }

  if (!strcmp(operation, "replace")) {
    int current = openat(parent, leaf, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    struct stat observed;
    char hash[65];
    if (current < 0 || fstat(current, &observed) < 0 || observed.st_dev != before.st_dev || observed.st_ino != before.st_ino || observed.st_nlink != 1 || sha256_fd(current, hash) < 0 || strcmp(hash, expected)) {
      if (current >= 0) close(current);
      result("blocked", "replace_race_detected");
      rc = 2;
      goto cleanup;
    }
    close(current);
  }

  unsigned flags = !strcmp(operation, "create") ? RENAME_NOREPLACE : 0;
  if (syscall(SYS_renameat2, parent, temp, parent, leaf, flags) < 0 || fsync(parent) < 0) { result("ambiguous", "atomic_install_uncertain"); rc = 4; goto cleanup; }
  {
    int final = openat(parent, leaf, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    struct stat verified;
    char final_hash[65];
    if (final < 0 || fstat(final, &verified) < 0 || !S_ISREG(verified.st_mode) || verified.st_nlink != 1 || sha256_fd(final, final_hash) < 0 || strcmp(final_hash, desired)) {
      if (final >= 0) close(final);
      result("ambiguous", "postcondition_unverified");
      rc = 4;
      goto done;
    }
    close(final);
  }
  result("succeeded", "atomic_install_verified");
  rc = 0;
  goto done;
cleanup:
  unlinkat(parent, temp, 0);
done:
  close(staged);
  close(parent);
  return rc;
}

static volatile sig_atomic_t timed_out;
static volatile sig_atomic_t worker_pid;
static void alarm_kill(int signal_number) {
  (void)signal_number;
  timed_out = 1;
  if (worker_pid > 0) kill((pid_t)worker_pid, SIGKILL);
}

static int bootstrap(int argc, char **argv) {
  if (getpid() != 1) { result("failed", "pid1_required"); return 3; }
  clearenv();
  if (mkdir("/workspace", 0700) < 0 && errno != EEXIST) return 3;
  if (mount("/dev/vdb", "/workspace", "ext4", MS_NODEV | MS_NOSUID | MS_NOEXEC, "") < 0) return 3;
  struct statfs fs;
  if (statfs("/workspace", &fs) < 0 || (unsigned long)fs.f_type != EXT4_SUPER_MAGIC) { umount2("/workspace", MNT_DETACH); return 3; }
  pid_t child = fork();
  if (child < 0) { umount2("/workspace", MNT_DETACH); return 3; }
  if (child == 0) {
    for (int capability = 0; capability <= CAP_LAST_CAP; capability++) {
      if (prctl(PR_CAPBSET_DROP, capability, 0, 0, 0) < 0 && errno != EINVAL) _exit(3);
    }
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0 || setgroups(0, NULL) < 0 || setgid(EXEC_GID) < 0 || setuid(EXEC_UID) < 0) _exit(3);
    _exit(worker(argc > 1 ? argv[1] : NULL, argc > 2 ? argv[2] : NULL, argc > 3 ? argv[3] : NULL, argc > 4 ? argv[4] : NULL, "/workspace"));
  }
  worker_pid = child;
  signal(SIGALRM, alarm_kill);
  alarm(WALL_SECONDS);
  int status;
  while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
  alarm(0);
  int workspace_fd = open("/workspace", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (workspace_fd >= 0) { syncfs(workspace_fd); close(workspace_fd); }
  umount2("/workspace", MNT_DETACH);
  syscall(SYS_reboot, 0xfee1dead, 672274793, 0x01234567, NULL);
  if (timed_out) { result("ambiguous", "wall_limit_exceeded"); return 124; }
  return WIFEXITED(status) ? WEXITSTATUS(status) : 4;
}

int main(int argc, char **argv) {
#ifdef KING_FILE_WRITE_TESTING
  const char *workspace = getenv("KING_TEST_WORKSPACE");
  if (workspace) return worker(argc > 1 ? argv[1] : NULL, argc > 2 ? argv[2] : NULL, argc > 3 ? argv[3] : NULL, argc > 4 ? argv[4] : NULL, workspace);
#endif
  return bootstrap(argc, argv);
}
