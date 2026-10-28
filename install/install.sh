#!/usr/bin/env bash
# OpenLifeDashboard installer, local mode on macOS and Linux (Architektura §12.4, §15.1; DEV §9.14).
#
#   install.sh [--mode local] [--dir <folder>] [--port <host port>] [--image <image>]
#              [--owner-email <e-mail>] [--owner-password-stdin] [--yes]
#
# Stages, each recorded in control/install-state.json when it is done:
#   preparing -> files -> images -> started -> owner -> complete
# files: the installation folder (D19.1). images: the image is present. started: the application
# runs and is healthy. owner: the application is stopped, the owner account is created in a
# one-off container under the writer lease (the password only on its stdin), complete: the
# application runs again. A rerun continues with the first stage that is not done.
#
# The script never overwrites: every file is written only when it does not exist, through a
# temporary file and an atomic rename, so an interrupted run leaves a folder that the next run
# continues. Secrets are generated once, with the first .env. Nothing is written before every
# check of the preflight has passed. The owner's password is never an argument, an environment
# variable or a file (D19.2 reads it from stdin).
set -u -o pipefail

readonly STATE_FORMAT_VERSION=1
readonly MIN_DOCKER_MAJOR=25        # start_interval of the healthcheck (docker/compose.yml)
readonly MIN_COMPOSE_MAJOR=2
readonly MIN_COMPOSE_MINOR=24
readonly MIN_FREE_KIB=1048576       # 1 GiB for the image, the database and its copies
readonly MIN_PORT=1024
readonly MAX_PORT=65535
readonly DEFAULT_PORT=8080
readonly START_TIMEOUT_SECONDS=180
# The rules of the owner's credentials, as the application states them (packages/contracts/src/http/identity.ts).
readonly PASSWORD_MIN_CODE_POINTS=12
readonly PASSWORD_MAX_CODE_POINTS=128
readonly OWNER_EMAIL_MAX_LENGTH=254
readonly CREDENTIAL_ATTEMPTS=5      # asks in a terminal before giving up
readonly CREATE_OWNER_COMMAND=(node apps/server/dist/cli/create-owner.js)

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mode="local"
dir=""
port=""
image=""
owner_email=""
owner_password=""
password_from_stdin="no"
assume_yes="no"
tmp_files=()

usage() {
  cat >&2 <<'USAGE'
usage: install.sh [--mode local] [--dir <folder>] [--port <port>] --image <image>
                  [--owner-email <e-mail>] [--owner-password-stdin] [--yes]

  --mode         local (default). The server mode arrives with a later release.
  --dir          installation folder (default ~/OpenLifeDashboard/default); a fresh or an
                 interrupted installation folder of this installer, never a foreign one
  --port         host port on 127.0.0.1, 1024-65535 (default 8080)
  --image        the application image to run (until the release package pins it)
  --owner-email  e-mail of the owner account (asked for when a terminal is attached)
  --owner-password-stdin
                 read the owner's password from the first line of stdin; without it the password
                 is typed twice at the terminal. It is never an argument, a variable or a file
  --yes          do not ask to confirm the folder when a terminal is attached
USAGE
}

say() { printf '%s\n' "$*"; }
note() { printf '%s\n' "$*" >&2; }
fail() { note "error: $*"; exit 1; }
usage_error() { note "error: $*"; usage; exit 2; }

cleanup() {
  local file
  for file in ${tmp_files[@]+"${tmp_files[@]}"}; do
    rm -f -- "$file"
  done
}
trap cleanup EXIT
# Ctrl+C or a termination request: leave no half-written file; the folder stays resumable.
trap 'note "interrupted: run the installer again to continue"; exit 130' INT TERM

# ---------------------------------------------------------------------------------- arguments

option_value() {
  [ "$#" -ge 2 ] && [ -n "$2" ] || usage_error "$1 needs a value"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode) option_value "$@"; mode="$2"; shift 2 ;;
    --dir) option_value "$@"; dir="$2"; shift 2 ;;
    --port) option_value "$@"; port="$2"; shift 2 ;;
    --image) option_value "$@"; image="$2"; shift 2 ;;
    --owner-email) option_value "$@"; owner_email="$2"; shift 2 ;;
    --owner-password-stdin) password_from_stdin="yes"; shift ;;
    --yes) assume_yes="yes"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage_error "unknown argument: $1" ;;
  esac
done

interactive="no"
if [ -t 0 ] && [ -t 2 ]; then
  interactive="yes"
fi

ask() { # ask <prompt> <default>: the answer, or the default when not interactive or empty
  local answer=""
  if [ "$interactive" = "yes" ]; then
    printf '%s [%s]: ' "$1" "$2" >&2
    IFS= read -r answer || answer=""
  fi
  printf '%s' "${answer:-$2}"
}

# ------------------------------------------------------------------------------ small helpers

has_control_characters() {
  case "$1" in
    *[[:cntrl:]]*) return 0 ;;
    *) return 1 ;;
  esac
}

random_hex() { # random_hex <bytes>
  local hex
  hex="$(od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n')"
  [ "${#hex}" -eq $(( $1 * 2 )) ] || fail "cannot read random bytes from /dev/urandom"
  printf '%s' "$hex"
}

uuid_v4() {
  local hex variant
  hex="$(random_hex 16)"
  variant="$(printf '%s' "89ab" | cut -c "$(( 0x${hex:16:1} % 4 + 1 ))")"
  printf '%s-%s-4%s-%s%s-%s' "${hex:0:8}" "${hex:8:4}" "${hex:13:3}" "$variant" "${hex:17:3}" "${hex:20:12}"
}

# "27.3.1", "v2.29.1-desktop.1" -> major and minor as integers
version_part() { # version_part <version> <1|2>
  local version="${1#v}"
  local part
  part="$(printf '%s' "$version" | cut -d. -f"$2" | sed 's/[^0-9].*$//')"
  printf '%s' "${part:-0}"
}

json_string() { # the JSON text of a string; control characters are refused earlier
  printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
}

# Writes <path> from stdin only when it does not exist: a temporary file in the same folder, then
# an atomic rename. Returns 1 (and writes nothing) when the file is already there.
write_new_file() { # write_new_file <path>
  local target="$1" temp
  if [ -e "$target" ]; then
    cat >/dev/null
    return 1
  fi
  temp="${target}.tmp.$$"
  tmp_files+=("$temp")
  cat >"$temp" || fail "cannot write $temp"
  mv -f -- "$temp" "$target" || fail "cannot create $target"
  return 0
}

copy_new_file() { # copy_new_file <source> <target>
  [ -f "$1" ] || fail "missing package file: $1"
  write_new_file "$2" <"$1"
}

# ----------------------------------------------------------------------------------- preflight

preflight_system() {
  case "$(uname -s)" in
    Darwin|Linux) ;;
    *) fail "this installer supports macOS and Linux; Windows has its own installer (install.ps1)" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64|arm64|aarch64) ;;
    *) fail "unsupported processor architecture: $(uname -m) (amd64 and arm64 only)" ;;
  esac
  if [ "$(id -u)" -eq 0 ]; then
    fail "do not run the installer as root: the application runs as your user and the folder belongs to you"
  fi
}

preflight_docker() {
  local server_version server_os compose_version output
  command -v docker >/dev/null 2>&1 || fail "Docker is not installed (docker command not found); install Docker and run the installer again"
  output="$(docker version --format '{{.Server.Version}}|{{.Server.Os}}' 2>&1)" ||
    fail "the Docker daemon is not reachable; start Docker and run the installer again. Docker said: $output"
  server_version="${output%%|*}"
  server_os="${output##*|}"
  [ "$server_os" = "linux" ] || fail "Docker runs $server_os containers; switch Docker to Linux containers"
  [ "$(version_part "$server_version" 1)" -ge "$MIN_DOCKER_MAJOR" ] ||
    fail "Docker Engine $server_version is too old; version $MIN_DOCKER_MAJOR or newer is needed"
  compose_version="$(docker compose version --short 2>&1)" ||
    fail "Docker Compose (the docker compose command) is not available. Docker said: $compose_version"
  local major minor
  major="$(version_part "$compose_version" 1)"
  minor="$(version_part "$compose_version" 2)"
  if [ "$major" -lt "$MIN_COMPOSE_MAJOR" ] || { [ "$major" -eq "$MIN_COMPOSE_MAJOR" ] && [ "$minor" -lt "$MIN_COMPOSE_MINOR" ]; }; then
    fail "Docker Compose $compose_version is too old; version $MIN_COMPOSE_MAJOR.$MIN_COMPOSE_MINOR or newer is needed"
  fi
}

port_in_use() { # something accepts connections on this port of the loopback address
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

preflight_port() {
  case "$port" in
    ''|*[!0-9]*) fail "the port must be a number, got: $port" ;;
  esac
  { [ "$port" -ge "$MIN_PORT" ] && [ "$port" -le "$MAX_PORT" ]; } ||
    fail "the port must be between $MIN_PORT and $MAX_PORT, got: $port"
  if port_in_use "$port"; then
    fail "port $port is already in use on this computer; choose another with --port"
  fi
}

nearest_existing_ancestor() {
  local path="$1"
  while [ ! -e "$path" ] && [ "$path" != "/" ]; do
    path="$(dirname "$path")"
  done
  printf '%s' "$path"
}

preflight_folder() {
  local ancestor free_kib
  if [ -e "$dir" ] && [ ! -d "$dir" ]; then
    fail "$dir exists and is not a folder"
  fi
  ancestor="$(nearest_existing_ancestor "$dir")"
  [ -d "$ancestor" ] && [ -w "$ancestor" ] || fail "no permission to create $dir (cannot write in $ancestor)"
  free_kib="$(df -Pk "$ancestor" | awk 'NR==2 {print $4}')"
  case "$free_kib" in
    ''|*[!0-9]*) fail "cannot read the free disk space of $ancestor" ;;
  esac
  [ "$free_kib" -ge "$MIN_FREE_KIB" ] || fail "less than 1 GiB of free disk space in $ancestor"

  # An installation folder is one that is empty, holds only folders (an interrupted first run),
  # or carries the state file of this installer. Anything else belongs to somebody else.
  state_file="$dir/control/install-state.json"
  if [ -d "$dir" ] && [ ! -f "$state_file" ]; then
    local foreign
    foreign="$(find "$dir" -mindepth 1 ! -type d 2>/dev/null | head -n 1)"
    [ -z "$foreign" ] || fail "$dir is not empty and is not an installation of this installer (found $foreign); choose a new folder with --dir"
  fi
  if [ -f "$state_file" ]; then
    resuming="yes"
  fi
}

validate_image() {
  [ -n "$image" ] || usage_error "--image is required (the release package will pin it later)"
  case "$image" in
    *[!A-Za-z0-9._/:@-]*) fail "the image reference contains characters that are not allowed: $image" ;;
  esac
}

# Why the e-mail would be refused by the application, or nothing. The address is ASCII only, as
# the application's own rule is: a letter with a diacritic is refused there after the container has
# started, so it is refused here, before anything is written.
owner_email_problem() {
  local email="$1"
  local pattern="^[A-Za-z0-9_+.'-]*[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\\.)+[A-Za-z]{2,}\$"
  has_control_characters "$email" && { printf 'it contains control characters'; return; }
  has_non_ascii "$email" && { printf 'it may use only the letters a-z, digits and . _ + - (no accented letters)'; return; }
  case "$email" in
    *' '*) printf 'it contains a space'; return ;;
  esac
  [ "${#email}" -le "$OWNER_EMAIL_MAX_LENGTH" ] || { printf 'it is longer than %s characters' "$OWNER_EMAIL_MAX_LENGTH"; return; }
  case "$email" in
    .*|*..*) printf 'it has a dot at the start or two dots in a row'; return ;;
  esac
  [[ "$email" =~ $pattern ]] || printf 'it does not look like an address (name@example.com)'
}

validate_owner_email() {
  [ -z "$owner_email" ] && return 0
  local problem
  problem="$(owner_email_problem "$owner_email")"
  [ -z "$problem" ] || fail "the owner e-mail is refused: $problem: $owner_email"
}

# True when a byte above 127 is present, whatever the locale of this shell.
has_non_ascii() {
  [ "$(printf '%s' "$1" | LC_ALL=C od -An -v -tu1 | LC_ALL=C awk '{ for (i = 1; i <= NF; i++) if ($i > 127) n++ } END { print n + 0 }')" -gt 0 ]
}

# Characters of a password as the application counts them: Unicode code points, whatever the locale
# of this shell. Bytes that continue a UTF-8 character (128-191) are not counted.
code_points() {
  printf '%s' "$1" | LC_ALL=C od -An -v -tu1 | LC_ALL=C awk '{ for (i = 1; i <= NF; i++) if ($i < 128 || $i > 191) n++ } END { print n + 0 }'
}

# Why the password would be refused by the application, or nothing.
owner_password_problem() {
  local password="$1" length
  [ -n "$password" ] || { printf 'it is empty'; return; }
  length="$(code_points "$password")"
  [ "$length" -ge "$PASSWORD_MIN_CODE_POINTS" ] || { printf 'it has %s characters and needs at least %s' "$length" "$PASSWORD_MIN_CODE_POINTS"; return; }
  [ "$length" -le "$PASSWORD_MAX_CODE_POINTS" ] || { printf 'it has %s characters and may have at most %s' "$length" "$PASSWORD_MAX_CODE_POINTS"; return; }
  # A tab is a valid character of a password; every other control character is not.
  case "${password//$'\t'/}" in
    *[[:cntrl:]]*) printf 'it contains control characters other than a tab' ;;
  esac
}

absolute_folder() { # the folder as an absolute path without a trailing slash
  local path="$1"
  case "$path" in
    "~") path="$HOME" ;;
    "~/"*) path="$HOME/${path#"~/"}" ;;
  esac
  case "$path" in
    /*) ;;
    *) path="$PWD/$path" ;;
  esac
  while [ "${#path}" -gt 1 ] && [ "${path%/}" != "$path" ]; do
    path="${path%/}"
  done
  printf '%s' "$path"
}

# ----------------------------------------------------------------------------------- state

stage_of_state() {
  sed -n 's/.*"stage"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' "$state_file" | head -n 1
}

write_state() { # write_state <stage>: replaces the state atomically (the one file that changes)
  local temp="${state_file}.tmp.$$"
  tmp_files+=("$temp")
  printf '{\n  "formatVersion": %s,\n  "stage": "%s",\n  "updatedAt": "%s"\n}\n' \
    "$STATE_FORMAT_VERSION" "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$temp" || fail "cannot write $temp"
  mv -f -- "$temp" "$state_file" || fail "cannot update $state_file"
}

# ------------------------------------------------------------------------------ the folder

project_name_of_instance() {
  sed -n 's/.*"composeProjectName"[[:space:]]*:[[:space:]]*"\(openlife-[0-9a-f]\{12\}\)".*/\1/p' "$dir/control/instance.json" | head -n 1
}

prepare_folders() {
  local sub
  for sub in data/backup data/logs/app data/tmp control/maintenance; do
    mkdir -p -- "$dir/$sub" || fail "cannot create $dir/$sub"
  done
  # The state file is the marker that this folder is ours: it comes right after the folders.
  if [ ! -f "$state_file" ]; then
    write_state preparing
  fi
}

prepare_instance_file() {
  write_new_file "$dir/control/instance.json" <<EOF && say "created control/instance.json"
{
  "formatVersion": 1,
  "instanceId": "$(uuid_v4)",
  "installMode": "$mode",
  "composeProjectName": "openlife-$(random_hex 6)",
  "hostPlatform": "posix",
  "installationPath": $(json_string "$dir"),
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
  true
}

prepare_env_file() {
  local project_name
  project_name="$(project_name_of_instance)"
  [ -n "$project_name" ] || fail "control/instance.json has no valid composeProjectName; the installation is damaged"
  write_new_file "$dir/.env" <<EOF && say "created .env (owner only, with new keys)"
INSTALL_MODE=$mode
BASE_URL=http://localhost:$port
BETTER_AUTH_SECRET=$(random_hex 32)
APP_ENCRYPTION_KEY=$(random_hex 32)
UPDATER_ENABLED=false
PORT=$port
APP_UID=$(id -u)
APP_GID=$(id -g)
COMPOSE_PROJECT_NAME=$project_name
COMPOSE_PATH_SEPARATOR=;
COMPOSE_FILE=compose.yml;compose.local.yml;control/compose.release.yml
EOF
  true
}

package_file() { # compose files sit next to the installer in a release package, in docker/ in the repository
  if [ -f "$script_dir/$1" ]; then
    printf '%s' "$script_dir/$1"
  else
    printf '%s' "$script_dir/../docker/$1"
  fi
}

prepare_compose_files() {
  local file
  for file in compose.yml compose.local.yml; do
    copy_new_file "$(package_file "$file")" "$dir/$file" && say "created $file"
  done
  write_new_file "$dir/control/compose.release.yml" <<EOF && say "created control/compose.release.yml"
services:
  app:
    image: $(json_string "$image")
EOF
  true
}

# A folder that reached "files" must still hold the files that carry the identity and the keys:
# a missing one is never made up again, because the data would no longer match.
require_identity_files() {
  local file
  for file in control/instance.json .env; do
    [ -f "$dir/$file" ] || fail "the installation is damaged: $dir/$file is missing; it is not recreated, because new keys would not open the existing data"
  done
}

# --------------------------------------------------------------------------- the owner

# The owner's credentials are collected before anything is written, and only while the owner
# account is still to be created.
read_owner_credentials() {
  local problem="" attempt=0
  if [ -z "$owner_email" ]; then
    [ "$interactive" = "yes" ] || usage_error "--owner-email is required when no terminal is attached"
    while :; do
      owner_email="$(ask "E-mail of the owner account" "")"
      problem="$(owner_email_problem "$owner_email")"
      [ -n "$owner_email" ] && [ -z "$problem" ] && break
      attempt=$((attempt + 1))
      [ "$attempt" -lt "$CREDENTIAL_ATTEMPTS" ] || fail "no valid e-mail was given; nothing was written"
      say "That e-mail is refused: ${problem:-it is empty}. Try again."
    done
  fi
  if [ "$password_from_stdin" = "yes" ]; then
    IFS= read -r owner_password || [ -n "$owner_password" ] || usage_error "--owner-password-stdin: nothing to read on stdin"
    owner_password="${owner_password%$'\r'}"
    problem="$(owner_password_problem "$owner_password")"
    [ -z "$problem" ] || fail "the owner's password is refused: $problem; nothing was written"
  elif [ "$interactive" = "yes" ]; then
    local again=""
    attempt=0
    while :; do
      printf 'Password of the owner account (%s to %s characters, not shown): ' "$PASSWORD_MIN_CODE_POINTS" "$PASSWORD_MAX_CODE_POINTS" >&2
      IFS= read -r -s owner_password; printf '\n' >&2
      problem="$(owner_password_problem "$owner_password")"
      if [ -z "$problem" ]; then
        printf 'Repeat the password: ' >&2
        IFS= read -r -s again; printf '\n' >&2
        [ "$owner_password" = "$again" ] && break
        problem="the two entries differ"
      fi
      attempt=$((attempt + 1))
      [ "$attempt" -lt "$CREDENTIAL_ATTEMPTS" ] || fail "no valid password was given; nothing was written"
      say "That password is refused: $problem. Try again."
    done
  else
    usage_error "the owner's password is needed: use --owner-password-stdin, or run the installer in a terminal"
  fi
}

# The one JSON object that create-owner reads from stdin. printf is a shell builtin, so the
# values never become the arguments of a process; sed only receives the escaping script.
owner_json() {
  local password_json
  password_json="$(json_string "$owner_password")"
  printf '{"email":%s,"password":%s}\n' "$(json_string "$owner_email")" "${password_json//$'\t'/\\t}"
}

# ------------------------------------------------------------------------------- the stages

stage_rank() {
  case "$1" in
    preparing) printf 0 ;;
    files) printf 1 ;;
    images) printf 2 ;;
    started) printf 3 ;;
    owner) printf 4 ;;
    complete) printf 5 ;;
    *) printf -- -1 ;;
  esac
}

compose() { # docker compose in the installation folder: .env there selects the project and files
  (cd "$dir" && docker compose "$@")
}

stage_images() {
  say "Image: checking $image"
  if docker image inspect "$image" >/dev/null 2>&1; then
    say "Image: present on this computer"
    return 0
  fi
  say "Image: pulling $image"
  docker pull "$image" ||
    fail "the image $image is not on this computer and could not be pulled (no internet, or no such image); the installation continues from here when you run the installer again"
}

start_and_wait() {
  compose up --detach --wait --wait-timeout "$START_TIMEOUT_SECONDS" ||
    fail "the application did not become healthy within $START_TIMEOUT_SECONDS seconds. Look at its log: cd \"$dir\" && docker compose logs app. Run the installer again to continue"
}

stage_start() {
  say "Start: the application is starting (up to $START_TIMEOUT_SECONDS seconds)"
  start_and_wait
}

stage_owner() {
  local output code
  say "Owner: stopping the application to create the owner account without a second writer"
  compose stop app || fail "cannot stop the application; the owner account was not created"
  say "Owner: creating the owner account in a one-off container"
  # -T: no terminal, so stdin is the pipe. --no-deps and no published ports: nothing is exposed.
  if output="$(owner_json | compose run --rm --no-deps -T --entrypoint "${CREATE_OWNER_COMMAND[0]}" app "${CREATE_OWNER_COMMAND[@]:1}" 2>&1)"; then
    say "Owner: the account was created"
    return 0
  fi
  code="$(printf '%s' "$output" | sed -n 's/.*"code":"\([A-Z_]*\)".*/\1/p' | head -n 1)"
  case "$code" in
    OWNER_ALREADY_EXISTS)
      say "Owner: an account already exists; it is kept as it is"
      return 0
      ;;
    INPUT_INVALID)
      fail "the owner account was not created: the e-mail or the password was refused ($(printf '%s' "$output" | sed -n 's/.*"fields":\[\([^]]*\)\].*/\1/p' | head -n 1)). The application is stopped; run the installer again to enter them"
      ;;
    *)
      fail "the owner account was not created (${code:-no code}). The application is stopped; run the installer again to retry. Details: $output"
      ;;
  esac
}

stage_finish() {
  say "Start: starting the application again"
  start_and_wait
}

print_summary() {
  say ""
  say "OpenLifeDashboard is installed."
  say "  Open:       http://localhost:$port (only from this computer)"
  say "  Sign in:    with the e-mail of the owner account; the first sign-in sets up the second factor (TOTP) and shows your recovery codes"
  say "  Data:       $dir/data"
  say "  Logs:       $dir/data/logs"
  say "  Backups:    $dir/data/backup"
  say "  Secrets:    $dir/.env - copy it to a safe place; without it the data cannot be opened"
  say "  Stop:       cd \"$dir\" && docker compose stop"
  say "  Start:      cd \"$dir\" && docker compose up --detach"
  say "A computer that sleeps or is off does not run the application, and a phone cannot reach localhost of this computer."
  say "Uninstalling means stopping it; the data stays until you delete the folder yourself."
}

# -------------------------------------------------------------------------------------- run

[ "$mode" = "local" ] || usage_error "the mode '$mode' is not available yet; only 'local' is supported"
resuming="no"
state_file=""
current_stage=""

preflight_system
validate_image
validate_owner_email

dir="${dir:-$(ask "Installation folder" "$HOME/OpenLifeDashboard/default")}"
has_control_characters "$dir" && fail "the folder path contains control characters"
dir="$(absolute_folder "$dir")"
state_file="$dir/control/install-state.json"

preflight_docker
preflight_folder

if [ "$resuming" = "yes" ]; then
  current_stage="$(stage_of_state)"
  [ "$(stage_rank "$current_stage")" -ge 0 ] || fail "$state_file has an unknown stage; the installation is damaged"
fi
rank="$(stage_rank "${current_stage:-preparing}")"

# The port of an interrupted installation is the one already in its .env; a new one is asked for.
if [ "$resuming" = "yes" ] && [ -f "$dir/.env" ]; then
  recorded_port="$(sed -n 's/^PORT=\([0-9]*\)$/\1/p' "$dir/.env" | head -n 1)"
  if [ -n "$port" ] && [ -n "$recorded_port" ] && [ "$port" != "$recorded_port" ]; then
    fail "this installation already uses port $recorded_port; run the installer without --port, or with --port $recorded_port"
  fi
  port="${port:-$recorded_port}"
fi
port="${port:-$(ask "Port on this computer (127.0.0.1)" "$DEFAULT_PORT")}"
# Once the application has started, the port is held by this very installation.
if [ "$rank" -lt 3 ]; then
  preflight_port
fi
[ "$rank" -ge 4 ] || read_owner_credentials

say "Installation folder: $dir"
say "Address:             http://localhost:$port (reachable only from this computer)"
if [ "$resuming" = "yes" ]; then
  say "Found an installation at the stage '$current_stage'; it is continued, nothing is overwritten."
elif [ "$interactive" = "yes" ] && [ "$assume_yes" = "no" ]; then
  confirmation="$(ask "Create it here? (yes/no)" "yes")"
  case "$confirmation" in
    y|Y|yes|YES|Yes) ;;
    *) say "Nothing was written."; exit 1 ;;
  esac
fi

umask 077
[ "$rank" -le 0 ] || require_identity_files

prepare_folders
prepare_instance_file
prepare_env_file
prepare_compose_files
if [ "$rank" -le 0 ]; then
  write_state files
fi

if [ "$rank" -le 1 ]; then stage_images; write_state images; fi
if [ "$rank" -le 2 ]; then stage_start; write_state started; fi
if [ "$rank" -le 3 ]; then stage_owner; write_state owner; fi
if [ "$rank" -le 4 ]; then stage_finish; write_state complete; fi
if [ "$rank" -ge 5 ]; then
  say "The installation is complete; nothing was changed. Status of its containers:"
  compose ps || note "cannot read the status of the containers"
fi
print_summary
