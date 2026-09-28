#!/usr/bin/env bash
# Regenerates fixtures/lockfiles/requirements/uv-*.txt: real `uv pip compile` and
# `uv export` output, produced offline.
#
# The compiled-requirements reader (packages/core/src/manifests/python.ts) was
# written and reviewed against hand-written fixtures three times, and each time a
# generator flag nobody had run broke it. These files are what the generator
# actually writes. Run this by hand when uv changes its output; tests and CI only
# read the committed files.
#
# Nothing here touches the network. Stub wheels are built locally, with fixed
# timestamps so their hashes are stable, and served to uv from a PEP 503 index on
# disk. Their graph:
#
#   requirements.in: langchain-aws, twilio
#   langchain-aws -> boto3            (extra `x` -> botocore)
#   boto3         -> botocore, s3transfer
#   s3transfer    -> botocore
#
# so the declared set is {langchain-aws, twilio} and botocore has two parents,
# which is the only shape that gets a bare `# via` block.
#
# One line is rewritten after generation: the `# from file:///<tmp>/simple`
# index annotation becomes `# from https://pypi.org/simple`, so no local path is
# committed. Everything else is uv's output as written. uv records its own command
# line in the header, and every path passed to it here is relative.
#
# Generated with uv 0.9.22.

set -euo pipefail

command -v uv >/dev/null || { echo 'uv is required' >&2; exit 1; }
echo "uv: $(uv --version)" >&2

repo=$(cd "$(dirname "$0")/.." && pwd)
out="$repo/fixtures/lockfiles/requirements"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$out"

python3 - "$work" <<'PY'
import hashlib, os, sys, zipfile
work = sys.argv[1]
os.makedirs(f"{work}/wheels"); os.makedirs(f"{work}/simple")
pkgs = {
    "boto3": ["botocore", "s3transfer"],
    "botocore": [],
    "s3transfer": ["botocore"],
    "langchain-aws": ["boto3", 'botocore ; extra == "x"'],
    "twilio": [],
    "sub-app": ["twilio"],
}
extras = {"langchain-aws": ["x"]}
for name, deps in pkgs.items():
    if name == "sub-app":
        continue
    dist = name.replace("-", "_")
    whl = f"{work}/wheels/{dist}-1.0.0-py3-none-any.whl"
    meta = f"Metadata-Version: 2.1\nName: {name}\nVersion: 1.0.0\n"
    meta += "".join(f"Provides-Extra: {e}\n" for e in extras.get(name, []))
    meta += "".join(f"Requires-Dist: {d}\n" for d in deps)
    files = {
        f"{dist}/__init__.py": "",
        f"{dist}-1.0.0.dist-info/METADATA": meta,
        f"{dist}-1.0.0.dist-info/WHEEL": "Wheel-Version: 1.0\nGenerator: stub\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
        f"{dist}-1.0.0.dist-info/RECORD": "",
    }
    with zipfile.ZipFile(whl, "w") as z:
        for path, content in files.items():
            z.writestr(zipfile.ZipInfo(path, date_time=(2020, 1, 1, 0, 0, 0)), content)
    sha = hashlib.sha256(open(whl, "rb").read()).hexdigest()
    os.makedirs(f"{work}/simple/{name}")
    with open(f"{work}/simple/{name}/index.html", "w") as f:
        f.write(f'<a href="file://{whl}#sha256={sha}">{os.path.basename(whl)}</a>')
with open(f"{work}/simple/index.html", "w") as f:
    f.write("".join(f'<a href="{n}/">{n}</a>' for n in pkgs if n != "sub-app"))
PY

export UV_CACHE_DIR="$work/cache" UV_NO_CONFIG=1
index="file://$work/simple"
cd "$work"

printf 'langchain-aws\ntwilio\n' > requirements.in
printf 'langchain-aws[x]\ntwilio\n' > extras.in
printf -- '-e ./sub\nlangchain-aws\n' > editable.in
mkdir -p sub/src/sub_app && touch sub/src/sub_app/__init__.py
printf '[project]\nname = "sub-app"\nversion = "0.1.0"\ndependencies = ["twilio"]\n[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n' > sub/pyproject.toml

mkdir -p app
printf '[project]\nname = "my-app"\nversion = "0.1.0"\nrequires-python = ">=3.12"\ndependencies = ["langchain-aws", "twilio"]\n\n[tool.uv]\npackage = false\n' > app/pyproject.toml

compile() {
  local name=$1 input=$2; shift 2
  uv pip compile "$input" --quiet --offline --index-url "$index" --python-version 3.12 -o "$name.txt" "$@"
}

compile split requirements.in
compile line requirements.in --annotation-style line
compile split-hashes requirements.in --generate-hashes
compile line-hashes requirements.in --annotation-style line --generate-hashes
compile index-split requirements.in --emit-index-annotation
compile index-line requirements.in --emit-index-annotation --annotation-style line
compile index-hashes requirements.in --emit-index-annotation --generate-hashes
compile no-header requirements.in --no-header
compile no-annotate requirements.in --no-annotate
compile extras extras.in --no-strip-extras
compile editable-project editable.in
compile from-pyproject app/pyproject.toml
compile no-emit-boto3 requirements.in --no-emit-package boto3
# The local project left out, as a Docker build does to cache its dependency
# layer: twilio's only parent is then a name the trailer lists as excluded.
compile no-emit-project editable.in --no-emit-package sub-app

# uv export of a virtual project ([tool.uv] package = false): no `-e .` line,
# yet every declared package is annotated `# via my-app`.
(cd app && uv lock --quiet --offline --index-url "$index" --python 3.12)
(cd app && uv export --quiet --frozen --offline -o ../export-default.txt)
(cd app && uv export --quiet --frozen --offline --no-emit-project -o ../export-no-emit-project.txt)
(cd app && uv export --quiet --frozen --offline --no-hashes -o ../export-no-hashes.txt)

for file in *.txt; do
  sed "s#file://$work/simple#https://pypi.org/simple#g" "$file" > "$out/uv-$file"
done
if grep -rl "$work" "$out" >/dev/null; then
  echo "a scratch path leaked into $out" >&2
  exit 1
fi
ls "$out" >&2
