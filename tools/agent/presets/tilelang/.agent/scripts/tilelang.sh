#!/bin/bash
set -eo pipefail
if [ "$#" -ne 2 ]; then
  printf '%s\n' 'Expected action and project root' >&2
  exit 2
fi
action=$1
project_root=$2
case "$action" in
  build|backend-context|semantic-regression|ir-verify) ;;
  *) printf '%s\n' 'Unsupported TileLang action' >&2; exit 2 ;;
esac
source "${DSH_CANN_ENV:?}"
source "${DSH_CONDA_SH:?}"
conda activate "${DSH_CONDA_ENV:?}"
venv_dir=${DSH_VENV_DIR:?}
case "$venv_dir" in /*) ;; *) venv_dir="$project_root/$venv_dir" ;; esac
source "$venv_dir/bin/activate"
set -u
build_dir=${DSH_BUILD_DIR:?}
case "$build_dir" in /*) ;; *) build_dir="$project_root/$build_dir" ;; esac
test -f "$build_dir/CMakeCache.txt"
export PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1
unset PYTHONPATH TVM_LIBRARY_PATH TVM_IMPORT_PYTHON_PATH
export XDG_CACHE_HOME="${DSH_CACHE_DIR:?}"
export CCACHE_DIR="$DSH_CACHE_DIR/ccache" CCACHE_TEMPDIR="$DSH_CACHE_DIR/ccache-tmp"
export TORCH_HOME="$DSH_CACHE_DIR/torch" TORCH_EXTENSIONS_DIR="$DSH_CACHE_DIR/torch-extensions"
export TILELANG_CACHE_DIR="$DSH_CACHE_DIR/tilelang" TILELANG_DISABLE_CACHE=1
if [ "$action" = build ]; then
  df -h "$build_dir"
  exec timeout "${DSH_BUILD_TIMEOUT_SECONDS:?}s" "${DSH_CMAKE:?}" --build "$build_dir" --parallel "${DSH_BUILD_JOBS:?}" --target tilelang tvm_runtime tilelang_cython_wrapper tilelang_pto_wrapper tilelang_ascend_npu_exchange tilelang_deepgemm_heuristics
fi
cd "$project_root"
exec python "$project_root/.agent/scripts/tilelang-check.py" "$action" "$project_root" "$build_dir"
