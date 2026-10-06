#!/bin/bash
set -eo pipefail
if [ "$#" -ne 2 ]; then
  printf '%s\n' 'Expected action and project root' >&2
  exit 2
fi
action=$1
project_root=$2
case "$action" in
  build|unit|ir-verify|reference) ;;
  *) printf '%s\n' 'Unsupported Ascend action' >&2; exit 2 ;;
esac
source "${DSH_CANN_ENV:?}"
source "${DSH_CONDA_SH:?}"
conda activate "${DSH_CONDA_ENV:?}"
set -u
build_dir=${DSH_BUILD_DIR:?}
case "$build_dir" in /*) ;; *) build_dir="$project_root/$build_dir" ;; esac
test -f "$build_dir/CMakeCache.txt"
export PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1
unset PYTHONPATH
export XDG_CACHE_HOME="${DSH_CACHE_DIR:?}"
export CCACHE_DIR="$DSH_CACHE_DIR/ccache" CCACHE_TEMPDIR="$DSH_CACHE_DIR/ccache-tmp"
case "$action" in
  build)
    df -h "$build_dir"
    exec timeout "${DSH_BUILD_TIMEOUT_SECONDS:?}s" ninja -C "$build_dir" -j"${DSH_BUILD_JOBS:?}" bishengir-opt bishengir-compile
    ;;
  reference)
    df -h "$build_dir"
    exec timeout "${DSH_BUILD_TIMEOUT_SECONDS:?}s" ninja -C "$build_dir" -j"${DSH_BUILD_JOBS:?}" check-bishengir
    ;;
  unit|ir-verify)
    exec python "$project_root/.agent/scripts/ascend-lit.py" "$action" "$project_root" "$build_dir"
    ;;
esac
