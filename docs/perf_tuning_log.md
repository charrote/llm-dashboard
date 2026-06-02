# LM Studio 推理性能调优日志

**日期**: 2026-05-27
**服务器**: llamacppserver-mtp-llama-server-1 (Docker)
**模型**: UANTEKDEV0 (Qwen3.6-35B-A3B, 35.5B params, Q4_K_M GGUF)
**后端**: llama.cpp MTP (Multi-Token Prediction) v2.13.0
**GPU**: AMD ROCm (通过 docker-compose 传递)

---

## 初始配置 (Round 1 - Baseline)

| 参数 | 值 |
|------|-----|
| ctx-size | 262144 |
| batch-size | 2048 |
| ubatch-size | 2048 |
| threads | 32 |
| threads-batch | 32 |
| parallel | 4 |
| cont-batching | 1 |
| cache-type-k | q4_0 |
| cache-type-v | q4_0 |
| flash-attn | 1 |
| split-mode | layer |
| spec-type | draft-mtp |
| spec-draft-n-max | 4 |
| draft-p-min | 0.5 |
| n-gpu-layers | 999 |
| mlock | 1 |

---

## Round 1 - Baseline 测试结果

| Context | Prompt TPS | Gen TPS | Gen Tokens | TTFT | Total Time |
|---------|-----------|---------|------------|------|------------|
| 0.5k    | 634.1     | 46.0    | 200        | 0.78s | 5.1s |
| 1k      | 1032.8    | 45.7    | 200        | 0.84s | 5.2s |
| 2k      | 1126.1    | 48.8    | 200        | 1.88s | 6.0s |
| 4k      | 1241.3    | 49.0    | 200        | 3.34s | 7.4s |
| 8k      | 1527.9    | 40.3    | 200        | 5.38s | 10.3s |

**Avg Gen TPS: 45.96 t/s**
**输出目录**: output/benchmark_openai_compat_UANTEKDEV0_20260527_113732/


## Round 2 - batch-size=4096

| Context | Prompt TPS | Gen TPS | Gen Tokens | TTFT | Total Time |
|---------|-----------|---------|------------|------|------------|
| 0.5k    | 818.8     | 46.2    | 200        | 0.60s | 4.9s |
| 1k      | 1043.1    | 42.0    | 200        | 0.83s | 5.6s |
| 2k      | 1141.6    | 44.7    | 200        | 1.85s | 6.3s |
| 4k      | 1253.8    | 44.6    | 200        | 3.31s | 7.8s |
| 8k      | 1504.1    | 44.0    | 200        | 5.47s | 10.0s |

**Avg Gen TPS: 44.30 t/s** (⬇ baseline 46.0)
**结论**: batch-size=4096 对 Gen TPS 无提升，恢复为 2048


## Round 3 - ubatch-size=512

| Context | Prompt TPS | Gen TPS | Gen Tokens | TTFT | Total Time |
|---------|-----------|---------|------------|------|------------|
| 0.5k    | 812.3     | 46.8    | 200        | 0.61s | 4.9s |
| 1k      | 840.5     | 43.7    | 180        | 1.03s | 5.1s |
| 2k      | 903.2     | 49.6    | 200        | 2.34s | 6.4s |
| 4k      | 1504.4    | 49.2    | 200        | 2.76s | 6.8s |
| 8k      | 1570.9    | 45.1    | 200        | 5.23s | 9.7s |

**Avg Gen TPS: 46.88 t/s** (⬆ baseline 46.0)
**结论**: ubatch-size=512 有轻微提升，Prompt TPS 提升明显


## Round 4 - threads=16, threads-batch=16 (ubatch-size=512)

| Context | Prompt TPS | Gen TPS | Gen Tokens | TTFT | Total Time |
|---------|-----------|---------|------------|------|------------|
| 0.5k    | 808.2     | 44.8    | 200        | 0.61s | 5.1s |
| 1k      | 838.1     | 45.5    | 165        | 1.03s | 4.7s |
| 2k      | 898.3     | 49.6    | 200        | 2.35s | 6.4s |
| 4k      | 1487.5    | 48.5    | 200        | 2.79s | 6.9s |
| 8k      | 1563.7    | 43.6    | 200        | 5.26s | 9.8s |

**Avg Gen TPS: 46.40 t/s** (≈ 基线 46.0)
**结论**: threads=16 无显著差异，恢复为 32


## Round 5 - parallel=2 (ubatch-size=512)

| Context | Prompt TPS | Gen TPS | Gen Tokens | TTFT | Total Time |
|---------|-----------|---------|------------|------|------------|
| 0.5k    | 800.5     | 48.8    | 200        | 0.62s | 4.7s |
| 1k      | 829.0     | 42.8    | 200        | 1.04s | 5.7s |
| 2k      | 882.6     | 47.0    | 200        | 2.39s | 6.7s |
| 4k      | 1467.9    | 49.0    | 200        | 2.83s | 6.9s |
| 8k      | 1544.2    | 45.5    | 200        | 5.32s | 9.7s |

**Avg Gen TPS: 46.62 t/s** (≈ 基线 46.0)
**结论**: parallel=2 无显著提升，恢复为 4


## Round 6 - cache-type-k/v = f16 (ubatch-size=512)

| Context | Prompt TPS | Gen TPS | Gen Tokens | TTFT | Total Time |
|---------|-----------|---------|------------|------|------------|
| 0.5k    | 822.9     | **53.2**| 200        | 0.60s | 4.4s |
| 1k      | 840.4     | 47.0    | 198        | 1.03s | 5.2s |
| 2k      | 911.1     | 46.9    | 200        | 2.32s | 6.6s |
| 4k      | 1508.2    | 48.1    | 200        | 2.75s | 6.9s |
| 8k      | 1590.2    | 46.9    | 200        | 5.17s | 9.4s |

**Avg Gen TPS: 48.42 t/s** (⬆⬆ 基线 46.0, +5.3%)
**结论**: cache-type=f16 明显提升生成速度，继续保留


## Round 7 - spec-draft-n-max=6 (cache-type=f16, ubatch=512)

| Context | Prompt TPS | Gen TPS | Gen Tokens | TTFT | Total Time |
|---------|-----------|---------|------------|------|------------|
| 0.5k    | 807.8     | 52.8    | 200        | 0.61s | 4.4s |
| 1k      | 838.2     | 47.3    | 200        | 1.03s | 5.3s |
| 2k      | 891.8     | 45.3    | 200        | 2.37s | 6.8s |
| 4k      | 1492.0    | 45.1    | 200        | 2.78s | 7.2s |
| 8k      | 1559.4    | 44.9    | 200        | 5.27s | 9.7s |

**Avg Gen TPS: 47.08 t/s** (⬇ Round6 48.4)
**结论**: n-max=6 不如 n-max=4，尝试 n-max=2


## Round 8 - spec-draft-n-max=2, draft-p-min=0.4 (cache=f16, ubatch=512)

| Context | Prompt TPS | **Gen TPS** | Gen Tokens | TTFT | Total Time |
|---------|-----------|:---------:|------------|------|------------|
| 0.5k    | 820.6     | **60.8** | 200        | 0.60s | 3.9s |
| 1k      | 851.4     | **54.6** | 200        | 1.02s | 4.7s |
| 2k      | 910.5     | **51.0** | 200        | 2.32s | 6.2s |
| 4k      | 1512.6    | **48.6** | 200        | 2.74s | 6.9s |
| 8k      | 1588.7    | **51.2** | 200        | 5.18s | 9.1s |

**Avg Gen TPS: 53.24 t/s** (⬆⬆⬆ 基线 46.0, +15.7%!) ⭐
**结论**: 当前最优配置！减少 MTP 草稿数加更低接受阈值大幅提升吞吐


## Round 9 - 无 MTP (f16 cache, ubatch=512)

| Context | Prompt TPS | Gen TPS | Gen Tokens | TTFT | Total Time |
|---------|-----------|---------|------------|------|------------|
| 0.5k    | 853.7     | 49.0    | 200        | 0.58s | 4.7s |
| 1k      | 883.5     | 48.7    | 200        | 0.98s | 5.1s |
| 2k      | 932.1     | 48.4    | 200        | 2.27s | 6.4s |
| 4k      | 1545.2    | 47.9    | 200        | 2.69s | 6.9s |
| 8k      | 1615.9    | 46.8    | 200        | 5.09s | 9.4s |

**Avg Gen TPS: 48.16 t/s** (⬆ 基线 46.0)
**结论**: 无 MTP 延迟最低但 Gen TPS 低于最优配置


## Round 10 - 最优配置全面验证 (max-tokens=500, 含16k上下文)

| Context | Prompt TPS | Gen TPS | Gen Tokens | TTFT | Total Time |
|---------|-----------|---------|------------|------|------------|
| 0.5k    | 819.0     | 57.3    | 325        | 0.60s | 6.3s |
| 1k      | 849.6     | 51.1    | 198        | 1.02s | 4.9s |
| 2k      | 905.7     | 47.0    | 500        | 2.33s | 13.0s |
| 4k      | 1506.6    | 47.6    | 500        | 2.75s | 13.2s |
| 8k      | 1579.1    | 47.7    | 500        | 5.21s | 15.7s |
| 16k     | 1473.8    | 47.8    | 500        | 11.13s | 21.6s |

**Avg Gen TPS: 49.71 t/s** ⭐ 稳定且高效
**结论**: 该配置在大上下文(16k)和长生成(500 tokens)下表现一致

---

## 最终推荐配置

```ini
batch-size = 2048
ubatch-size = 512
threads = 32
threads-batch = 32
parallel = 4
cache-type-k = f16
cache-type-v = f16
flash-attn = 1
spec-type = draft-mtp
spec-draft-n-max = 2
spec-draft-p-min = 0.4
```

