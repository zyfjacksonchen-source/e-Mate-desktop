# lxml and linked-library source materials

This directory accompanies the Python runtime in the same installer resource volume. `manifest.json` identifies every original source archive and recipe by URL, size and SHA-256. Source archives retain their original licenses. `../<platform>/office-notices` contains supplemental notices. The lxml interface uses LGPL libiconv internally; the provided source is available for inspection, modification and rebuilding under its included license.

Copy these materials to a separate writable directory before extracting or editing. Keep the installed runtime and a recovery copy intact. No app account or online authorization is needed to read the sources. Ordinary Office tasks do not run this rebuild procedure.

## Reproduced macOS ARM64 build

Prerequisites: Xcode Command Line Tools and CPython 3.12 for the matching architecture. This procedure was executed with the prepared e-Mate CPython 3.12.14 runtime on macOS ARM64. It is a source-rebuild result, not evidence of replacement inside an installed application or Windows execution.

1. Extract `sources/lxml-6.1.3.tar.gz` into a fresh working directory. Use Python 3.12's `tarfile` data filter or a source-aware archive tool.
2. Inside the extracted `lxml-6.1.3`, create `libs`. Copy these original archives into it without changing their bytes: `libxml2-2.14.6.tar.xz`, `libxslt-1.1.43.tar.xz`, `zlib-1.3.2.tar.gz`. Copy `gnu-libiconv-1.18.tar.gz` under the filename `libiconv-1.18.tar.gz`. The upstream builder verifies these archive digests before reuse.
3. Create a separate build virtual environment with CPython 3.12. The tested build tools were setuptools 80.9.0, wheel 0.45.1 and packaging 25.0. Install these only in that build environment. The source contains generated C; the command below deliberately does not require Cython.
4. For a modification test, add the following branch at the beginning of `_patch_library(libdir)` in the **working copy** of `buildlibxml.py`. It alters the freshly extracted libiconv source after the original archive has been verified, and before compilation. Replace the harmless marker with the desired source changes for a real modification.

```python
if libdir and os.path.basename(libdir) == "libiconv-1.18":
    marker_source = Path(libdir) / "lib" / "iconv.c"
    marker_source.write_text(marker_source.read_text() +
        '\nconst char emate_relink_probe[] = "e-Mate modified libiconv proof";\n')
```

5. From the extracted lxml directory, run the build environment's Python:

```sh
export MACOSX_DEPLOYMENT_TARGET=12.0
export ARCHFLAGS='-arch arm64'
export CFLAGS='-O2 -arch arm64'
export LDFLAGS='-arch arm64'
../venv/bin/python setup.py build_ext --inplace --without-cython --static-deps \
  --libxml2-version=2.14.6 --libxslt-version=1.1.43 \
  --libiconv-version=1.18 --zlib-version=1.3.2 --multicore=2
```

Set both compiler and linker architecture flags: upstream otherwise defaults dependency linking to universal x86_64+ARM64, which cannot link ARM64-only objects. This build retains the original libxslt backport patch. It does not change the provided source archives or the app's pinned production wheel.

6. To check the rebuilt interface with the same CPython 3.12 interpreter, start it with `-I`, explicitly insert the absolute working-copy `src` directory at the beginning of `sys.path`, and import `lxml.etree` and `lxml.objectify`. Check `etree.__file__` points there. The reproduced check found the marker bytes in the linked extension and passed ISO-8859-1 conversion, objectify, XSLT and existing python-pptx document reading. `-I` ignores `PYTHONPATH`; setting that variable alone is not a replacement test.

## Windows source mapping

The selected Windows wheel was matched byte-for-byte to official lxml build artifact 9843595966. Job 100212452276 used digest-verified dependency archives from `lxml/libxml2-win-binaries` release 2026.05.17: libxml2 2.11.9, libxslt 1.1.45, zlib 1.3.2 and iconv 1.17.1. Its global cache label does not override those Windows versions.

`recipes/windows/.gitmodules` maps the accompanying fixed source archives to their expected checkout paths. `build.ps1`, the workflow and `libiconv.patch` retain the upstream build instructions. Raw archive project files use CRLF whereas the patch uses LF; the supplied patch passed `git apply --check --ignore-space-change` against those files. Windows compilation, modified-library relinking, installed permissions and recovery have not yet been executed by this macOS check.

Before reporting installed replacement as verified on either platform, test the final candidate's actual interpreter, extension path, permissions, application launch and restoration of the original bytes. A successful source build or import from this working copy alone does not establish those results.
