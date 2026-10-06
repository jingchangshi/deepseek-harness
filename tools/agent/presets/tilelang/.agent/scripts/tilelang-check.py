"""Check source syntax, native semantics, and source-only CPU lowering."""

import ast
import os
from pathlib import Path
import runpy
import sys

action = sys.argv[1]
source = Path(sys.argv[2]).resolve()
if action == 'source-syntax':
    files = sorted((source / 'tilelang').rglob('*.py'))
    if not files:
        raise FileNotFoundError(source / 'tilelang')
    for filename in files:
        ast.parse(filename.read_bytes(), filename=str(filename))
    print(f'Parsed {len(files)} Python sources')
    raise SystemExit(0)

tests = {
    'backend-context': [
        'testing/python/backend/test_tilelang_backend_module.py',
        'testing/python/backend/test_tilelang_backend_auto_schedule.py',
    ],
    'semantic-regression': [
        'testing/python/transform/test_tilelang_transform_verify_parallel_loop.py',
        'testing/python/transform/test_tilelang_transform_verify_buffer_init.py',
    ],
    'ir-verify': [
        'testing/python/transform/test_tilelang_transform_simplify.py',
        'testing/ascend/transform/test_ascend_thread_sync.py',
        'testing/python/cpu/test_tilelang_cpu_bf16_legalize.py::test_cpu_lowering_survives_storage_legalization',
        'testing/python/cpu/test_tilelang_cpu_vec_type.py::test_cpu_c_codegen_vectorizes_parallel_arith',
    ],
}[action]
build = Path(sys.argv[3]).resolve()
runtime = build / '.agent-python'
runtime.mkdir(exist_ok=True)
for name, target in {'tilelang': source / 'tilelang', '3rdparty': source / '3rdparty', 'build': build}.items():
    link = runtime / name
    if link.is_symlink():
        if link.resolve() != target.resolve():
            raise ValueError(f'Import link points to a different checkout: {link}')
    else:
        link.symlink_to(target, target_is_directory=True)
sys.path.insert(0, str(runtime))
os.environ['TVM_LIBRARY_PATH'] = os.pathsep.join([str(build / 'lib'), str(build / 'tvm')])
os.environ['TVM_IMPORT_PYTHON_PATH'] = str(source / '3rdparty/tvm/python')
import tilelang
from tilelang import tvm

if Path(tilelang._LIB_PATH).resolve() != build / 'lib/libtilelang.so':
    raise ValueError('TileLang did not load the selected native build')
print(f'TileLang source: {tilelang.__file__}; native library: {tilelang._LIB_PATH}')
if action == 'ir-verify':
    example = runpy.run_path(str(source / 'testing/python/cpu/test_tilelang_cpu_vec_type.py'))
    func = example['vec_arith']
    with tvm.target.Target('c'):
        artifact = tilelang.lower(func, target='c', target_host='c', enable_host_codegen=False, enable_device_compile=False)
    if 'float4' not in artifact.kernel_source:
        raise ValueError('CPU source-only codegen did not emit float4 arithmetic')
    print(tvm.IRModule.from_expr(func).script())
    print(artifact.kernel_source)
import pytest

raise SystemExit(pytest.main(['-q', '-rs', '-o', f'cache_dir={build / ".pytest_cache"}', *tests]))
