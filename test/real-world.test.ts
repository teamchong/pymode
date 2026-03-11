// Real-world Python patterns — proves PyMode handles popular library usage.
//
// Each test takes code you'd find in real Python repos and runs it
// through the full worker stack.

import { describe, it, expect } from "vitest";
import { runPython as run } from "./helpers";

// Pattern 1: Data analysis pipeline (pandas-style, numpy only)
// Real repos: any Flask/FastAPI data API, Jupyter notebook backends
describe("data analysis patterns", () => {
  it("should compute descriptive statistics like pandas.describe()", async () => {
    const { text, status } = await run(`
import numpy as np
import json

# Simulate a real dataset (e.g. from a CSV upload)
data = np.array([23.5, 19.2, 31.7, 28.4, 22.1, 35.6, 27.3, 20.8, 33.9, 25.0,
                 18.7, 29.5, 24.6, 32.1, 21.3, 30.2, 26.8, 19.9, 34.7, 22.8])

# Descriptive statistics (mean, std, min, max, sorted-based quartiles)
sorted_data = np.sort(data)
n = len(data)
result = {
    "count": int(n),
    "mean": round(float(np.mean(data)), 2),
    "std": round(float(np.std(data, ddof=1)), 2),
    "min": float(np.min(data)),
    "median": round(float(sorted_data[n//2] if n % 2 else (sorted_data[n//2-1] + sorted_data[n//2])/2), 2),
    "max": float(np.max(data)),
    "range": round(float(np.max(data) - np.min(data)), 2),
}
print(json.dumps(result))
`);
    expect(status, text.slice(0, 500)).toBe(200);
    const result = JSON.parse(text);
    expect(result.count).toBe(20);
    expect(result.mean).toBeCloseTo(26.43, 1);
    expect(result.min).toBe(18.7);
    expect(result.max).toBe(35.6);
  });

  it("should handle moving averages (finance/timeseries pattern)", async () => {
    const { text, status } = await run(`
import numpy as np
import json

# Stock prices (AAPL-like daily closes)
prices = np.array([150.2, 152.1, 149.8, 153.5, 155.0, 154.2, 156.8, 158.1, 157.3, 159.0,
                   160.2, 158.5, 161.3, 163.0, 162.1, 164.5, 165.8, 163.2, 167.0, 168.5])

# Simple moving average (SMA)
window = 5
sma = np.convolve(prices, np.ones(window)/window, mode='valid')

# Daily returns
returns = np.diff(prices) / prices[:-1]

result = {
    "sma_last": round(float(sma[-1]), 2),
    "sma_len": len(sma),
    "avg_daily_return": round(float(np.mean(returns) * 100), 4),
    "volatility": round(float(np.std(returns) * 100), 4),
    "max_drawdown_pct": round(float(np.min(returns) * 100), 4),
    "sharpe_approx": round(float(np.mean(returns) / np.std(returns)), 4),
}
print(json.dumps(result))
`);
    expect(status, text.slice(0, 500)).toBe(200);
    const result = JSON.parse(text);
    expect(result.sma_len).toBe(16);
    expect(result.sma_last).toBeGreaterThan(160);
    expect(typeof result.sharpe_approx).toBe("number");
  });
});

// Pattern 2: ML-style computation (scikit-learn patterns, numpy-only)
// Real repos: sklearn, fastai data preprocessing, feature engineering
describe("ML computation patterns", () => {
  it("should do linear regression (sklearn-style)", async () => {
    const { text, status } = await run(`
import numpy as np
import json

# Training data: house size (sq ft) vs price ($k)
X = np.array([600, 800, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400], dtype=np.float64)
y = np.array([150, 180, 210, 250, 280, 310, 340, 380, 410, 440], dtype=np.float64)

# Least squares: y = mx + b
n = len(X)
m = (n * np.sum(X * y) - np.sum(X) * np.sum(y)) / (n * np.sum(X**2) - np.sum(X)**2)
b = (np.sum(y) - m * np.sum(X)) / n

# Predictions
predictions = m * X + b
residuals = y - predictions
r_squared = 1 - np.sum(residuals**2) / np.sum((y - np.mean(y))**2)

# Predict for a new house
new_size = 1500
predicted_price = m * new_size + b

result = {
    "slope": round(float(m), 4),
    "intercept": round(float(b), 2),
    "r_squared": round(float(r_squared), 4),
    "predicted_1500sqft": round(float(predicted_price), 2),
    "rmse": round(float(np.sqrt(np.mean(residuals**2))), 2),
}
print(json.dumps(result))
`);
    expect(status, text.slice(0, 500)).toBe(200);
    const result = JSON.parse(text);
    expect(result.r_squared).toBeGreaterThan(0.99);
    expect(result.predicted_1500sqft).toBeGreaterThan(280);
    expect(result.predicted_1500sqft).toBeLessThan(310);
  });

  it("should normalize features (sklearn StandardScaler pattern)", async () => {
    const { text, status } = await run(`
import numpy as np
import json

# Feature matrix: age, salary, experience
X = np.array([
    [25, 50000, 2],
    [30, 60000, 5],
    [35, 75000, 8],
    [40, 90000, 12],
    [45, 110000, 15],
    [50, 130000, 20],
], dtype=np.float64)

# StandardScaler: (x - mean) / std
mean = X.mean(axis=0)
std = X.std(axis=0)
X_scaled = (X - mean) / std

# MinMaxScaler: (x - min) / (max - min)
X_min = X.min(axis=0)
X_max = X.max(axis=0)
X_minmax = (X - X_min) / (X_max - X_min)

result = {
    "scaled_means": [round(float(x), 10) for x in X_scaled.mean(axis=0)],
    "scaled_stds": [round(float(x), 4) for x in X_scaled.std(axis=0)],
    "minmax_min": [round(float(x), 4) for x in X_minmax.min(axis=0)],
    "minmax_max": [round(float(x), 4) for x in X_minmax.max(axis=0)],
    "shape": list(X_scaled.shape),
}
print(json.dumps(result))
`);
    expect(status, text.slice(0, 500)).toBe(200);
    const result = JSON.parse(text);
    // StandardScaler: mean should be ~0, std should be 1
    for (const m of result.scaled_means) expect(Math.abs(m)).toBeLessThan(1e-10);
    for (const s of result.scaled_stds) expect(s).toBeCloseTo(1.0, 2);
    // MinMaxScaler: range [0, 1]
    for (const m of result.minmax_min) expect(m).toBe(0);
    for (const m of result.minmax_max) expect(m).toBe(1);
  });

  it("should compute cosine similarity (NLP/search pattern)", async () => {
    const { text, status } = await run(`
import numpy as np
import json

# Simulated word embeddings (like word2vec/BERT output)
embeddings = {
    "king": np.array([0.5, 0.8, -0.1, 0.3, 0.9]),
    "queen": np.array([0.6, 0.7, -0.2, 0.4, 0.8]),
    "man": np.array([0.3, 0.5, 0.2, 0.1, 0.4]),
    "woman": np.array([0.4, 0.4, 0.1, 0.2, 0.3]),
    "car": np.array([-0.5, 0.1, 0.8, -0.3, -0.2]),
}

def cosine_sim(a, b):
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))

# king-queen should be more similar than king-car
result = {
    "king_queen": round(cosine_sim(embeddings["king"], embeddings["queen"]), 4),
    "king_man": round(cosine_sim(embeddings["king"], embeddings["man"]), 4),
    "king_car": round(cosine_sim(embeddings["king"], embeddings["car"]), 4),
    "woman_queen": round(cosine_sim(embeddings["woman"], embeddings["queen"]), 4),
}
print(json.dumps(result))
`);
    expect(status, text.slice(0, 500)).toBe(200);
    const result = JSON.parse(text);
    expect(result.king_queen).toBeGreaterThan(result.king_car);
    expect(result.king_queen).toBeGreaterThan(0.9);
    expect(result.king_car).toBeLessThan(0.2);
  });
});

// Pattern 3: Image/signal processing (Pillow/scipy-style, numpy only)
// Real repos: image APIs, audio processing
describe("signal processing patterns", () => {
  it("should apply convolution filters (image processing)", async () => {
    const { text, status } = await run(`
import numpy as np
import json

# Simulate a 5x5 grayscale image
image = np.array([
    [10, 20, 30, 20, 10],
    [20, 40, 60, 40, 20],
    [30, 60, 100, 60, 30],
    [20, 40, 60, 40, 20],
    [10, 20, 30, 20, 10],
], dtype=np.float64)

# 3x3 edge detection kernel (Laplacian)
kernel = np.array([
    [0, -1, 0],
    [-1, 4, -1],
    [0, -1, 0],
], dtype=np.float64)

# Manual 2D convolution (no scipy needed)
h, w = image.shape
kh, kw = kernel.shape
pad_h, pad_w = kh // 2, kw // 2
padded = np.zeros((h + 2*pad_h, w + 2*pad_w))
padded[pad_h:pad_h+h, pad_w:pad_w+w] = image

output = np.zeros_like(image)
for i in range(h):
    for j in range(w):
        output[i, j] = np.sum(padded[i:i+kh, j:j+kw] * kernel)

result = {
    "center_value": float(output[2, 2]),
    "corner_value": float(output[0, 0]),
    "output_shape": list(output.shape),
    "max_edge": float(np.max(np.abs(output))),
}
print(json.dumps(result))
`);
    expect(status, text.slice(0, 500)).toBe(200);
    const result = JSON.parse(text);
    expect(result.output_shape).toEqual([5, 5]);
    expect(result.center_value).toBeGreaterThan(0); // center has strong edges
  });

  it("should compute signal correlation (audio/signal analysis)", async () => {
    const { text, status } = await run(`
import numpy as np
import json

# Generate two signals and compute cross-correlation
sample_rate = 1000
t = np.arange(0, 0.1, 1/sample_rate)  # 100 samples
signal_a = np.sin(2 * np.pi * 50 * t)
signal_b = np.sin(2 * np.pi * 50 * t + 0.5)  # phase-shifted

# Correlation coefficient
corr = float(np.sum(signal_a * signal_b) / (np.sqrt(np.sum(signal_a**2)) * np.sqrt(np.sum(signal_b**2))))

# RMS energy
rms_a = float(np.sqrt(np.mean(signal_a**2)))
rms_b = float(np.sqrt(np.mean(signal_b**2)))

# Zero crossings (simple frequency estimation)
crossings = int(np.sum(np.diff(np.sign(signal_a)) != 0))

result = {
    "sample_count": len(t),
    "correlation": round(corr, 4),
    "rms_a": round(rms_a, 4),
    "rms_b": round(rms_b, 4),
    "zero_crossings": crossings,
}
print(json.dumps(result))
`);
    expect(status, text.slice(0, 500)).toBe(200);
    const result = JSON.parse(text);
    expect(result.sample_count).toBe(100);
    expect(result.correlation).toBeGreaterThan(0.5); // correlated signals
    expect(result.rms_a).toBeCloseTo(0.7071, 2); // sin RMS = 1/sqrt(2)
    expect(result.zero_crossings).toBeGreaterThan(5);
  });
});

// Pattern 4: JSON API response computation (httpbin/FastAPI pattern)
// Real repos: httpbin, FastAPI, Django REST Framework
describe("API computation patterns", () => {
  it("should process batch JSON requests (real API pattern)", async () => {
    const { text, status } = await run(`
import numpy as np
import json

# Simulate a batch scoring API (e.g. recommendation engine)
request = {
    "users": [
        {"id": 1, "features": [0.5, 0.3, 0.8, 0.1, 0.9]},
        {"id": 2, "features": [0.2, 0.7, 0.4, 0.6, 0.3]},
        {"id": 3, "features": [0.9, 0.1, 0.5, 0.8, 0.2]},
    ],
    "items": [
        {"id": 101, "features": [0.4, 0.6, 0.7, 0.2, 0.8]},
        {"id": 102, "features": [0.8, 0.2, 0.3, 0.9, 0.1]},
        {"id": 103, "features": [0.1, 0.9, 0.5, 0.4, 0.6]},
    ]
}

# Compute dot-product scores (user-item affinity matrix)
user_matrix = np.array([u["features"] for u in request["users"]])
item_matrix = np.array([i["features"] for i in request["items"]])
scores = user_matrix @ item_matrix.T

# Build response with top recommendation per user
response = {"recommendations": []}
for i, user in enumerate(request["users"]):
    top_item_idx = int(np.argmax(scores[i]))
    response["recommendations"].append({
        "user_id": user["id"],
        "top_item_id": request["items"][top_item_idx]["id"],
        "score": round(float(scores[i][top_item_idx]), 4),
        "all_scores": [round(float(s), 4) for s in scores[i]],
    })

print(json.dumps(response))
`);
    expect(status, text.slice(0, 500)).toBe(200);
    const result = JSON.parse(text);
    expect(result.recommendations).toHaveLength(3);
    for (const rec of result.recommendations) {
      expect(rec.user_id).toBeDefined();
      expect(rec.top_item_id).toBeDefined();
      expect(rec.score).toBeGreaterThan(0);
      expect(rec.all_scores).toHaveLength(3);
    }
  });

  it("should do weighted scoring (analytics/ranking pattern)", async () => {
    const { text, status } = await run(`
import numpy as np
import json

# Product ranking: weighted multi-criteria scoring
# Real pattern from e-commerce recommendation engines
products = np.array([
    # [rating, reviews, price, delivery_days]
    [4.5, 1200, 29.99, 2],
    [4.8, 350, 49.99, 1],
    [4.2, 5000, 19.99, 3],
    [4.7, 800, 39.99, 1],
    [3.9, 200, 14.99, 5],
    [4.6, 2000, 34.99, 2],
])

# Normalize each column to [0, 1]
mins = products.min(axis=0)
maxs = products.max(axis=0)
normalized = (products - mins) / (maxs - mins)

# Invert price and delivery (lower is better)
normalized[:, 2] = 1 - normalized[:, 2]
normalized[:, 3] = 1 - normalized[:, 3]

# Weighted score
weights = np.array([0.3, 0.2, 0.25, 0.25])
scores = normalized @ weights

# Rank products
ranking = np.argsort(-scores)

result = {
    "scores": [round(float(s), 4) for s in scores],
    "ranking": [int(r) + 1 for r in ranking],  # 1-indexed
    "top_product_idx": int(ranking[0]),
    "top_score": round(float(scores[ranking[0]]), 4),
}
print(json.dumps(result))
`);
    expect(status, text.slice(0, 500)).toBe(200);
    const result = JSON.parse(text);
    expect(result.scores).toHaveLength(6);
    expect(result.ranking).toHaveLength(6);
    expect(result.top_score).toBeGreaterThan(0.5);
  });
});

// Pattern 5: Pure Python stdlib (no numpy) — proves base variant works
// Real repos: httpbin, Flask utils, Django ORM-like patterns
describe("pure Python patterns (no numpy)", () => {
  it("should handle URL parsing and routing (httpbin pattern)", async () => {
    const { text, status } = await run(`
import json
from urllib.parse import urlparse, parse_qs

# Simulate httpbin-style request inspection
url = "https://httpbin.org/get?name=pymode&version=1.0&tags=fast&tags=wasm"
parsed = urlparse(url)
params = parse_qs(parsed.query)

result = {
    "scheme": parsed.scheme,
    "host": parsed.hostname,
    "path": parsed.path,
    "params": {k: v for k, v in params.items()},
}
print(json.dumps(result))
`);
    expect(status, text.slice(0, 500)).toBe(200);
    const result = JSON.parse(text);
    expect(result.scheme).toBe("https");
    expect(result.host).toBe("httpbin.org");
    expect(result.params.name).toEqual(["pymode"]);
    expect(result.params.tags).toEqual(["fast", "wasm"]);
  });

  it("should handle dataclass serialization (Pydantic-style pattern)", async () => {
    const { text, status } = await run(`
import json
from dataclasses import dataclass, field, asdict
from typing import List

@dataclass
class Address:
    street: str
    city: str
    zip_code: str

@dataclass
class User:
    name: str
    email: str
    age: int
    addresses: List[Address] = field(default_factory=list)

    def is_adult(self):
        return self.age >= 18

# Create and serialize (like Pydantic model_dump)
user = User(
    name="Alice",
    email="alice@example.com",
    age=30,
    addresses=[
        Address("123 Main St", "San Francisco", "94105"),
        Address("456 Oak Ave", "New York", "10001"),
    ]
)

result = asdict(user)
result["is_adult"] = user.is_adult()
print(json.dumps(result))
`);
    expect(status, text.slice(0, 500)).toBe(200);
    const result = JSON.parse(text);
    expect(result.name).toBe("Alice");
    expect(result.is_adult).toBe(true);
    expect(result.addresses).toHaveLength(2);
    expect(result.addresses[0].city).toBe("San Francisco");
  });

  it("should handle CSV processing (data import pattern)", async () => {
    const { text, status } = await run(`
import csv
import io
import json

csv_data = """name,age,city,salary
Alice,30,San Francisco,120000
Bob,25,New York,95000
Charlie,35,Seattle,140000
Diana,28,Austin,105000
Eve,32,Boston,115000"""

reader = csv.DictReader(io.StringIO(csv_data))
rows = list(reader)

# Aggregate by city (pandas groupby equivalent)
total_salary = sum(int(r["salary"]) for r in rows)
avg_age = sum(int(r["age"]) for r in rows) / len(rows)

result = {
    "row_count": len(rows),
    "columns": list(rows[0].keys()),
    "avg_age": avg_age,
    "total_salary": total_salary,
    "cities": sorted(set(r["city"] for r in rows)),
}
print(json.dumps(result))
`);
    expect(status, text.slice(0, 500)).toBe(200);
    const result = JSON.parse(text);
    expect(result.row_count).toBe(5);
    expect(result.columns).toEqual(["name", "age", "city", "salary"]);
    expect(result.total_salary).toBe(575000);
    expect(result.cities).toContain("San Francisco");
  });
});
