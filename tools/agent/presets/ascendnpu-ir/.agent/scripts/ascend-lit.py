"""Run focused lit checks with the selected build's tools and output directory."""

import ast
from pathlib import Path
import re
import sys
import tempfile

action, source_argument, build_argument = sys.argv[1:]
source = Path(source_argument).resolve()
build = Path(build_argument).resolve()
site = build / 'tools/bishengir/bishengir/test/lit.site.cfg.py'
configuration = site.read_text()
assignments = {
    statement.targets[0].attr: statement.value.value
    for statement in ast.parse(configuration).body
    if isinstance(statement, ast.Assign)
    and len(statement.targets) == 1
    and isinstance(statement.targets[0], ast.Attribute)
    and isinstance(statement.targets[0].value, ast.Name)
    and statement.targets[0].value.id == 'config'
    and isinstance(statement.value, ast.Constant)
    and isinstance(statement.value.value, str)
}
original_build = Path(assignments['llvm_tools_dir']).parent
original_source = Path(assignments['bishengir_src_root']).parent
replacements = {str(original_build): str(build), str(original_source): str(source)}
configuration = re.sub(
    '|'.join(re.escape(path) for path in sorted(replacements, key=len, reverse=True)),
    lambda match: replacements[match.group()],
    configuration,
)
tests = {
    'unit': [
        'Dialect/HIVM/regbase',
        'Dialect/HIVM/Regbase',
        'Dialect/HIVM/RegBase',
    ],
    'ir-verify': [
        'Dialect/HIVM/hivm-opt-single-point.mlir',
        'Dialect/HIVM/hivm-pipeline.mlir',
        'Dialect/HIVM/hivm-pipeline-skip-bind-sub-block.mlir',
        'Dialect/HIVM/core-ratio-pipeline.mlir',
        'Dialect/HIVM/vf-operand-substitution-pipeline.mlir',
        'Dialect/HIVM/bufferize-hivm-pipeline.mlir',
        'bishengir-compile/commandline.mlir',
    ],
}[action]
for filename in ['bishengir-opt', 'bishengir-compile', 'FileCheck']:
    if not (build / 'bin' / filename).is_file():
        raise FileNotFoundError(build / 'bin' / filename)
sys.path.insert(0, str(source / 'third-party/llvm-project/llvm/utils/lit'))
from lit.main import main

with tempfile.TemporaryDirectory(prefix='dsh-ascend-lit-') as temporary:
    relocated = Path(temporary) / 'lit.site.cfg.py'
    relocated.write_text(configuration)
    sys.argv = [sys.argv[0], '-v', *[str(source / 'bishengir/test' / path) for path in tests]]
    main({'config_map': {str(source / 'bishengir/test/lit.cfg.py'): str(relocated)}})
