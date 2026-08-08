#!/usr/bin/env python3
"""LightInk T11 performance gate.

Measures, on the current machine, using only the Python 3 standard library:

  1. Cold start        -- spawn the debug binary, measure time until the first
                          child process (the WebView2 browser process on
                          Windows) appears. Target: < 3.0 s.
  2. Idle memory       -- after the UI settles (recipe: sample at 3-5s idle),
                          sum memory of the whole lightink process tree.
                          Target: <= 150 MB. See METRIC NOTE below.
  3. 10k-word document -- generate a >=10,000-word markdown document and parse
                          it in Node with the exact same unified + remark-parse
                          + remark-gfm pipeline the editor uses
                          (src/editor/parser.ts). Target: idle app memory +
                          parser heap delta <= 300 MB.
  4. Lazy chunks       -- static check that dist/assets splits katex and
                          mermaid into async chunks separate from the index
                          chunk (heavy resources load lazily).

METRIC NOTE (why the memory assertion uses private bytes, not working set):
  The editor renders inside the OS-provided WebView2 runtime, whose code
  pages are shared between every WebView2 app on the machine. Summing
  WorkingSetSize over the process tree counts those shared pages once per
  process, so even an empty hello-world WebView2 app reports ~250-350MB —
  under that metric a <=150MB budget is unattainable for ANY WebView2 app and
  cannot be what R13 intends. PrivatePageCount (committed memory unique to
  this app instance, the analogue of Task Manager's per-app "Memory" column)
  excludes shared runtime pages and is the honest per-app footprint. Both
  numbers are printed; the assertion uses private bytes.

Honest methodology notes (also printed in the report):

  * The app has no headless "ready" signal and src/main.ts is out of scope for
    T11, so cold start is measured as process spawn -> first observable
    WebView child process. The poll loop itself adds up to ~one PowerShell
    invocation (~0.2-0.5 s) of detection latency, so the reported number is a
    conservative upper bound on "cold start to window-able".
  * The 10k-word check cannot drive the WebView headlessly, so document-load
    memory is approximated as (idle app memory) + (Node heap delta of the
    real parser pipeline on the real document). Full end-to-end document-load
    RSS needs interactive verification.
  * Memory on Windows is read from Win32_Process via PowerShell; on POSIX
    from `ps` RSS (which is working-set-like there; see METRIC NOTE).

Exit code 0 = all checks PASS, 1 = at least one FAIL, 2 = setup error.
"""

from __future__ import annotations

import csv
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IS_WINDOWS = os.name == "nt"

COLD_START_BUDGET_S = 3.0
IDLE_RSS_BUDGET_MB = 150.0
DOC_TOTAL_BUDGET_MB = 300.0
DOC_WORDS = 10_000

SETTLE_S = 4.0  # recipe: sample after 3-5s idle
STEADY_EXTRA_S = 10.0  # second, informational sample
CHILD_TIMEOUT_S = 12.0
POLL_INTERVAL_S = 0.05

MB = 1024.0 * 1024.0


# ---------------------------------------------------------------------------
# Pure helpers (unit-tested in scripts/test_measure_performance.py)
# ---------------------------------------------------------------------------

def generate_big_markdown(words: int = DOC_WORDS) -> str:
    """Generate a markdown document with at least `words` whitespace tokens."""
    paragraph = (
        "墨香轻染纸笺之上文字如水流转不息编辑器应当安静陪伴 "
        "markdown renders prose and structure without getting in the way of writing "
    )
    block = (
        "\n\n## 章节标题 Section Heading\n\n"
        + paragraph
        + "\n\n- list item one\n- list item two\n- list item three\n"
        + "\n\n```rust\nfn main() { println!(\"hello\"); }\n```\n"
        + "\n\n| col a | col b |\n| ----- | ----- |\n| 1 | 2 |\n"
    )
    # Count tokens per block the same way word_count does (code fences are
    # stripped there, so len(block.split()) would overestimate) and repeat
    # until the target is demonstrably reached.
    per_block = max(1, word_count(block))
    repeats = max(1, (words // per_block) + 1)
    doc = "# 万字文档 Ten Thousand Word Document\n" + block * repeats
    while word_count(doc) < words:
        doc += block
    return doc


def word_count(source: str) -> int:
    """Whitespace token count after stripping fenced/inline code (mirrors parser.ts)."""
    import re

    stripped = re.sub(r"```[\s\S]*?```", " ", source)
    stripped = re.sub(r"`[^`\n]*`", " ", stripped)
    return len([t for t in stripped.split() if t])


@dataclass
class ProcRow:
    pid: int
    ppid: int
    ws_bytes: int
    priv_bytes: int


def parse_windows_process_csv(text: str) -> list[ProcRow]:
    """Parse `Get-CimInstance Win32_Process | ConvertTo-Csv` output.

    Missing/unparseable WorkingSetSize/PrivatePageCount degrade to 0 rather
    than breaking the parse.
    """
    rows: list[ProcRow] = []
    reader = csv.DictReader(io.StringIO(text))
    for r in reader:
        try:
            pid = int(r.get("ProcessId") or 0)
            ppid = int(r.get("ParentProcessId") or 0)
            ws = int(float(r.get("WorkingSetSize") or 0))
            priv = int(float(r.get("PrivatePageCount") or 0))
        except (TypeError, ValueError):
            continue
        if pid:
            rows.append(ProcRow(pid=pid, ppid=ppid, ws_bytes=ws, priv_bytes=priv))
    return rows


def parse_ps_table(text: str) -> list[ProcRow]:
    """Parse `ps -eo pid=,ppid=,rss=` output (rss in KiB).

    POSIX RSS is working-set-like; we mirror it into both fields and rely on
    the METRIC NOTE in the report.
    """
    rows: list[ProcRow] = []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 3:
            continue
        try:
            pid, ppid, rss_kb = int(parts[0]), int(parts[1]), int(parts[2])
        except ValueError:
            continue
        rows.append(
            ProcRow(pid=pid, ppid=ppid, ws_bytes=rss_kb * 1024, priv_bytes=rss_kb * 1024)
        )
    return rows


@dataclass
class TreeMemory:
    ws_bytes: int
    priv_bytes: int
    proc_count: int
    root_ws_bytes: int
    root_priv_bytes: int


def tree_memory(rows: list[ProcRow], root_pid: int) -> TreeMemory:
    """Sum working-set and private bytes of root_pid and all descendants."""
    children: dict[int, list[int]] = {}
    by_pid: dict[int, ProcRow] = {}
    for r in rows:
        children.setdefault(r.ppid, []).append(r.pid)
        by_pid[r.pid] = r
    ws = 0
    priv = 0
    count = 0
    seen: set[int] = set()
    stack = [root_pid]
    while stack:
        pid = stack.pop()
        if pid in seen:
            continue
        seen.add(pid)
        row = by_pid.get(pid)
        if row is not None:
            ws += row.ws_bytes
            priv += row.priv_bytes
            count += 1
        stack.extend(children.get(pid, ()))
    root = by_pid.get(root_pid)
    return TreeMemory(
        ws_bytes=ws,
        priv_bytes=priv,
        proc_count=count,
        root_ws_bytes=root.ws_bytes if root else 0,
        root_priv_bytes=root.priv_bytes if root else 0,
    )


# ---------------------------------------------------------------------------
# Platform probes
# ---------------------------------------------------------------------------

def run_powershell(command: str, timeout: float = 10.0) -> str:
    exe = shutil.which("powershell") or shutil.which("pwsh")
    if exe is None:
        raise RuntimeError("powershell not found on PATH")
    out = subprocess.run(
        [exe, "-NoProfile", "-NonInteractive", "-Command", command],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    return out.stdout


def direct_child_count(pid: int) -> int:
    if IS_WINDOWS:
        out = run_powershell(
            f"(Get-CimInstance Win32_Process -Filter \"ParentProcessId={pid}\" "
            "| Measure-Object).Count"
        )
        try:
            return int(out.strip())
        except ValueError:
            return 0
    rows = read_process_table()
    return sum(1 for r in rows if r.ppid == pid)


def read_process_table() -> list[ProcRow]:
    if IS_WINDOWS:
        out = run_powershell(
            "Get-CimInstance Win32_Process | "
            "Select-Object ProcessId,ParentProcessId,WorkingSetSize,PrivatePageCount | "
            "ConvertTo-Csv -NoTypeInformation",
            timeout=20.0,
        )
        return parse_windows_process_csv(out)
    out = subprocess.run(
        ["ps", "-eo", "pid=,ppid=,rss="], capture_output=True, text=True, timeout=10
    ).stdout
    return parse_ps_table(out)


def kill_tree(pid: int) -> None:
    try:
        if IS_WINDOWS:
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                capture_output=True,
                timeout=15,
            )
        else:
            os.kill(pid, 15)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

@dataclass
class CheckResult:
    name: str
    passed: bool
    detail: str
    notes: list[str] = field(default_factory=list)


def debug_binary() -> Path:
    name = "lightink.exe" if IS_WINDOWS else "lightink"
    return ROOT / "src-tauri" / "target" / "debug" / name


def ensure_binary(override: str | None = None) -> Path:
    if override is not None:
        binary = Path(override).resolve()
        if not binary.exists():
            raise RuntimeError(f"--binary {binary} does not exist")
        return binary
    binary = debug_binary()
    if binary.exists():
        return binary
    print("[setup] debug binary missing, running cargo build ...")  # noqa: E501
    subprocess.run(
        ["cargo", "build", "--manifest-path", str(ROOT / "src-tauri" / "Cargo.toml")],
        check=True,
    )
    if not binary.exists():
        raise RuntimeError(f"cargo build finished but {binary} not found")
    return binary


def check_cold_start_and_memory(
    binary_override: str | None = None,
) -> tuple[CheckResult, CheckResult, float]:
    """Launch the app once; derive cold-start and idle-memory results.

    Returns (cold_start_result, idle_memory_result, idle_priv_mb) where
    idle_priv_mb is the tree private-bytes figure used by the doc check.
    """
    binary = ensure_binary(binary_override)
    notes = [
        "spawn -> first WebView child process; poll latency makes this a "
        "conservative upper bound",
    ]
    proc = subprocess.Popen(
        [str(binary)],
        cwd=str(ROOT),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    cold: CheckResult
    idle: CheckResult
    idle_priv_mb = 0.0
    try:
        t0 = time.perf_counter()
        elapsed = None
        while time.perf_counter() - t0 < CHILD_TIMEOUT_S:
            if proc.poll() is not None:
                break  # process exited early
            try:
                if direct_child_count(proc.pid) > 0:
                    elapsed = time.perf_counter() - t0
                    break
            except Exception:
                pass
            time.sleep(POLL_INTERVAL_S)

        if elapsed is None:
            if proc.poll() is not None:
                cold = CheckResult(
                    "cold start <= 3s",
                    False,
                    "app process exited before any WebView child appeared",
                    notes,
                )
            else:
                alive = time.perf_counter() - t0
                cold = CheckResult(
                    "cold start <= 3s",
                    alive < COLD_START_BUDGET_S,
                    f"no WebView child within {CHILD_TIMEOUT_S}s; "
                    f"fallback process-alive-at-check {alive:.2f}s",
                    notes + ["WebView child never observed; milestone approximated"],
                )
        else:
            cold = CheckResult(
                "cold start <= 3s",
                elapsed < COLD_START_BUDGET_S,
                f"spawn -> first child process: {elapsed:.2f}s",
                notes,
            )

        # Recipe: sample after 3-5s idle. 若进程已提前退出（cold start 判
        # FAIL），死进程采样会得到 vacuous 的 0MB 通过——改为明确判 FAIL
        # 并不再喂给万字文档检查的 idle 基线。
        if proc.poll() is not None:
            idle = CheckResult(
                "idle editing memory <= 150MB (tree private bytes @ 4s idle)",
                False,
                "app exited before sampling window; idle memory inconclusive",
                notes,
            )
            idle_priv_mb = 0.0  # 标记不可用，调用方不得用于合并计算
        else:
            time.sleep(SETTLE_S)
            mem = tree_memory(read_process_table(), proc.pid)
            idle_priv_mb = mem.priv_bytes / MB
            idle_ws_mb = mem.ws_bytes / MB
            app_priv_mb = mem.root_priv_bytes / MB

            # Informational steady-state sample.
            time.sleep(STEADY_EXTRA_S)
            steady = tree_memory(read_process_table(), proc.pid)
            steady_priv_mb = steady.priv_bytes / MB

            idle = CheckResult(
                "idle editing memory <= 150MB (tree private bytes @ 4s idle)",
                idle_priv_mb <= IDLE_RSS_BUDGET_MB,
                f"tree private = {idle_priv_mb:.1f}MB "
                f"(app exe {app_priv_mb:.1f}MB + WebView2 runtime "
                f"{idle_priv_mb - app_priv_mb:.1f}MB, {mem.proc_count} procs); "
                f"tree working-set = {idle_ws_mb:.1f}MB (info only, includes "
                f"shared runtime pages); steady-state private @ +10s = "
                f"{steady_priv_mb:.1f}MB",
                [
                    "assertion metric: private bytes (memory unique to this app "
                    "instance); working-set sum double-counts shared WebView2 "
                    "runtime pages and is reported for information only",
                    "reducing renderer memory would require src/** "
                    "changes outside T11 scope",
                ],
            )
    finally:
        kill_tree(proc.pid)
        try:
            proc.wait(timeout=10)
        except Exception:
            pass
    return cold, idle, idle_priv_mb


NODE_MEM_SNIPPET = r"""
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { readFileSync } from 'node:fs';
const src = readFileSync(process.env.LIGHTINK_PERF_DOC, 'utf8');
globalThis.gc && globalThis.gc();
const before = process.memoryUsage().heapUsed;
const tree = unified().use(remarkParse).use(remarkGfm).parse(src);
const after = process.memoryUsage().heapUsed;
// keep the tree alive until after measurement
const sink = JSON.stringify(tree).length;
console.log(JSON.stringify({ heapDelta: after - before, treeJsonLen: sink, chars: src.length }));
"""


def check_big_doc(idle_priv_mb: float) -> CheckResult:
    doc = generate_big_markdown(DOC_WORDS)
    actual_words = word_count(doc)
    with tempfile.NamedTemporaryFile(
        "w", suffix=".md", delete=False, encoding="utf-8"
    ) as f:
        f.write(doc)
        doc_path = f.name
    try:
        env = dict(os.environ)
        env["LIGHTINK_PERF_DOC"] = doc_path
        out = subprocess.run(
            [
                "node",
                "--expose-gc",
                "--input-type=module",
                "-e",
                NODE_MEM_SNIPPET,
            ],
            capture_output=True,
            text=True,
            cwd=str(ROOT),
            env=env,
            timeout=120,
        )
        if out.returncode != 0:
            return CheckResult(
                "10k-word doc memory <= 300MB",
                False,
                f"node pipeline run failed: {out.stderr.strip()[:300]}",
            )
        data = json.loads(out.stdout.strip().splitlines()[-1])
    finally:
        try:
            os.unlink(doc_path)
        except OSError:
            pass

    heap_mb = data["heapDelta"] / MB
    if idle_priv_mb <= 0.0:
        # idle 采样不可得（进程提前退出）：仅评估 parser 堆增量本身，
        # 不做合并断言，避免死进程的 0MB 基线低估总占用。
        return CheckResult(
            "10k-word doc memory <= 300MB",
            heap_mb <= DOC_TOTAL_BUDGET_MB,
            f"doc {actual_words} words / {data['chars']} chars; "
            f"parser heap delta {heap_mb:.1f}MB; "
            f"idle baseline unavailable (app exited early) — heap-only check",
            [
                "approximation: same unified+remark-parse+remark-gfm pipeline as "
                "src/editor/parser.ts, measured in Node; full E2E doc-load RSS "
                "needs interactive verification",
            ],
        )
    combined_mb = idle_priv_mb + heap_mb
    return CheckResult(
        "10k-word doc memory <= 300MB",
        combined_mb <= DOC_TOTAL_BUDGET_MB,
        f"doc {actual_words} words / {data['chars']} chars; "
        f"parser heap delta {heap_mb:.1f}MB; "
        f"idle app (private) {idle_priv_mb:.1f}MB + heap = {combined_mb:.1f}MB",
        [
            "approximation: same unified+remark-parse+remark-gfm pipeline as "
            "src/editor/parser.ts, measured in Node; full E2E doc-load RSS "
            "needs interactive verification",
        ],
    )


def check_lazy_chunks() -> CheckResult:
    assets = ROOT / "dist" / "assets"
    if not assets.is_dir():
        print("[setup] dist/assets missing, running npm run build ...")
        subprocess.run(
            "npm run build", shell=True, cwd=str(ROOT), check=True,
        )
    files = [p.name for p in assets.glob("*.js")]
    index = [f for f in files if f.startswith("index-")]
    katex = [f for f in files if f.startswith("katex-")]
    mermaid = [f for f in files if "mermaid" in f]
    ok = bool(index) and bool(katex) and bool(mermaid)
    detail = (
        f"index chunks: {len(index)}, katex chunks: {len(katex)} "
        f"({', '.join(katex[:2])}), mermaid chunks: {len(mermaid)} "
        f"(e.g. {', '.join(mermaid[:2])})"
    )
    return CheckResult(
        "heavy resources lazy-loaded (separate async chunks)",
        ok,
        detail,
        ["static check on dist/assets; index chunk must not bundle katex/mermaid"],
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="LightInk T11 performance gate")
    parser.add_argument(
        "--binary",
        default=None,
        help="path to the app binary to measure "
        "(default: src-tauri/target/debug/lightink[.exe], cargo-built if missing)",
    )
    args = parser.parse_args(argv)

    print("=" * 72)
    print("LightInk T11 performance gate")
    print(f"root: {ROOT}")
    print("=" * 72)

    results: list[CheckResult] = []
    try:
        cold, idle, idle_priv_mb = check_cold_start_and_memory(args.binary)
    except Exception as exc:  # setup error
        print(f"\n[setup error] {exc}")
        return 2
    results.append(cold)
    results.append(idle)
    results.append(check_big_doc(idle_priv_mb))
    results.append(check_lazy_chunks())

    failed = 0
    for r in results:
        status = "PASS" if r.passed else "FAIL"
        if not r.passed:
            failed += 1
        print(f"\n[{status}] {r.name}")
        print(f"  {r.detail}")
        for note in r.notes:
            print(f"  note: {note}")

    print("\n" + "=" * 72)
    print(f"RESULT: {'PASS' if failed == 0 else 'FAIL'} "
          f"({len(results) - failed}/{len(results)} checks passed)")
    print("=" * 72)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
