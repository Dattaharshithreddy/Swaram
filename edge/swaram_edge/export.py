"""Export IndicF5 to four ONNX graphs for phones, plus int8 versions.

Real weights (needs access to the gated ai4bharat/IndicF5 repo):

    python -m swaram_edge.export --hf --out build/edge

Placeholder weights (speed testing only; the audio is noise):

    python -m swaram_edge.export --random --out build/edge-random

Writes ``mel.onnx``, ``context.onnx``, ``step.onnx``, ``vocoder.onnx``,
``step.int8.onnx``, ``vocab.json`` and ``manifest.json`` into ``--out``.
Only the step graph is quantized: it holds ~97% of the weights and runs on
every step. The small context graph gets bigger, not smaller, when quantized.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

import torch

from .f5 import HOP_LENGTH, N_MELS, SAMPLE_RATE, F5Config, build_dit, load_dit, read_vocab
from .graphs import ContextEncoder, FlowStep, MelEncoder, VocosDecoder
from .vocos_loader import build_vocos_24khz, load_vocos

INDICF5_REPO = "ai4bharat/IndicF5"
OPSET = 17


def _find(snapshot: Path, names: tuple[str, ...]) -> Path:
    for name in names:
        hits = sorted(snapshot.rglob(name))
        if hits:
            return hits[0]
    raise FileNotFoundError(f"None of {names} found under {snapshot}")


def fetch_indicf5() -> tuple[Path, Path]:
    """Download IndicF5 and return (checkpoint, vocab) paths."""
    from huggingface_hub import snapshot_download

    snapshot = Path(
        snapshot_download(
            INDICF5_REPO,
            allow_patterns=["*.safetensors", "*.pt", "*.txt", "*.json"],
        )
    )
    ckpt = _find(snapshot, ("model.safetensors", "*.safetensors", "*.pt"))
    vocab = _find(snapshot, ("vocab.txt", "*vocab*.txt"))
    return ckpt, vocab


def _export(module: torch.nn.Module, args: tuple, path: Path, inputs, outputs, dynamic_axes) -> None:
    with torch.no_grad():
        torch.onnx.export(
            module,
            args,
            str(path),
            input_names=inputs,
            output_names=outputs,
            dynamic_axes=dynamic_axes,
            opset_version=OPSET,
            do_constant_folding=True,
            dynamo=False,
        )


def quantize(src: Path | str, dst: Path | str) -> None:
    """Dynamic int8 for MatMul/Gemm weights: ~4x smaller, fast on ARM CPUs."""
    from onnxruntime.quantization import QuantType, quantize_dynamic

    quantize_dynamic(
        str(src),
        str(dst),
        weight_type=QuantType.QInt8,
        op_types_to_quantize=["MatMul", "Gemm"],
        per_channel=True,
    )


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def export_all(dit, cfg: F5Config, vocos, vocab: list[str], out: Path, *, quantize_int8: bool = True) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    timings = {}

    def timed(name, fn):
        t0 = time.perf_counter()
        fn()
        timings[name] = round(time.perf_counter() - t0, 1)
        print(f"  {name}: {timings[name]} s")

    frames, n_text = 200, 60
    wav = torch.randn(1, SAMPLE_RATE * 2) * 0.1
    text = torch.randint(0, cfg.vocab_size, (1, n_text), dtype=torch.long)
    cond = torch.randn(1, frames, N_MELS)
    x = torch.randn(1, frames, N_MELS)
    ctx = torch.randn(2, frames, cfg.dim)
    t = torch.tensor([0.3])
    cfg_strength = torch.tensor([2.0])
    mel = torch.randn(1, N_MELS, frames)

    timed(
        "mel",
        lambda: _export(MelEncoder().eval(), (wav,), out / "mel.onnx", ["wav"], ["mel"],
                        {"wav": {1: "samples"}, "mel": {1: "frames"}}),
    )
    timed(
        "context",
        lambda: _export(ContextEncoder(dit).eval(), (text, cond), out / "context.onnx", ["text", "cond"], ["ctx"],
                        {"text": {1: "n_text"}, "cond": {1: "frames"}, "ctx": {1: "frames"}}),
    )
    timed(
        "step",
        lambda: _export(FlowStep(dit).eval(), (x, ctx, t, cfg_strength), out / "step.onnx",
                        ["x", "ctx", "t", "cfg"], ["v"],
                        {"x": {1: "frames"}, "ctx": {1: "frames"}, "v": {1: "frames"}}),
    )
    timed(
        "vocoder",
        lambda: _export(VocosDecoder(vocos).eval(), (mel,), out / "vocoder.onnx", ["mel"], ["wav"],
                        {"mel": {2: "frames"}, "wav": {1: "samples"}}),
    )

    if quantize_int8:
        # In a fresh process: quantizing a 1.3 GB graph next to the loaded
        # PyTorch model does not fit in 8 GB of RAM.
        timed(
            "quantize step",
            lambda: subprocess.run(
                [sys.executable, "-c",
                 "import sys; from swaram_edge.export import quantize; quantize(sys.argv[1], sys.argv[2])",
                 str(out / "step.onnx"), str(out / "step.int8.onnx")],
                check=True,
            ),
        )

    (out / "vocab.json").write_text(json.dumps(vocab, ensure_ascii=False), encoding="utf-8")
    files = sorted(p.name for p in out.glob("*.onnx"))
    manifest = {
        "format": "swaram-edge/1",
        "model": "IndicF5 (ai4bharat/IndicF5, MIT) + Vocos (charactr/vocos-mel-24khz, MIT)",
        "config": json.loads(cfg.to_json()),
        "sample_rate": SAMPLE_RATE,
        "hop_length": HOP_LENGTH,
        "n_mels": N_MELS,
        "defaults": {"steps": 16, "cfg_strength": 2.0, "sway_coef": -1.0, "target_rms": 0.1},
        "files": {name: {"bytes": (out / name).stat().st_size, "sha256": _sha256(out / name)} for name in files},
        "export_seconds": timings,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--hf", action="store_true", help="Download IndicF5 and Vocos from Hugging Face")
    src.add_argument("--checkpoint", help="Local IndicF5 checkpoint (.safetensors/.pt); needs --vocab")
    src.add_argument("--random", action="store_true", help="Placeholder weights for speed tests")
    p.add_argument("--vocab", help="vocab.txt for --checkpoint")
    p.add_argument("--vocos-dir", help="Folder with Vocos pytorch_model.bin (default: download)")
    p.add_argument("--out", required=True)
    p.add_argument("--no-int8", action="store_true")
    p.add_argument("--depth", type=int, help="With --random: fewer transformer layers (tests)")
    args = p.parse_args()

    if args.random:
        cfg = F5Config()
        if args.depth:
            cfg.depth = args.depth
        torch.manual_seed(0)
        dit = build_dit(cfg)
        vocos = build_vocos_24khz()
        vocab = [" "] + [chr(c) for c in range(0x0C00, 0x0C80)]  # Telugu block, placeholder
    else:
        if args.hf:
            ckpt, vocab_path = fetch_indicf5()
        else:
            if not args.vocab:
                p.error("--checkpoint needs --vocab")
            ckpt, vocab_path = Path(args.checkpoint), Path(args.vocab)
        vocab = read_vocab(vocab_path)
        dit, cfg = load_dit(ckpt, len(vocab))
        vocos = load_vocos(args.vocos_dir)

    print(f"Exporting to {args.out} (depth={cfg.depth}, vocab={len(vocab)})")
    manifest = export_all(dit, cfg, vocos, vocab, Path(args.out), quantize_int8=not args.no_int8)
    for name, info in manifest["files"].items():
        print(f"  {name}: {info['bytes'] / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
