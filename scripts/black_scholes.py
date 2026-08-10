"""Black-Scholes delta using only the standard library (math.erf).

Dividend yield is assumed 0 (stated in the dashboard methodology); this
slightly overstates call delta for dividend payers.
"""
from math import erf, log, sqrt


def norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + erf(x / sqrt(2.0)))


def call_delta(spot: float, strike: float, t_years: float, iv: float, r: float):
    """Returns delta in [0, 1], or None if inputs are unusable."""
    if spot <= 0 or strike <= 0:
        return None
    if t_years <= 0:
        return 1.0 if spot > strike else 0.0
    if iv is None or iv != iv or iv < 0.005:  # NaN or absurdly low IV
        return None
    d1 = (log(spot / strike) + (r + iv * iv / 2.0) * t_years) / (iv * sqrt(t_years))
    return norm_cdf(d1)


def put_delta(spot: float, strike: float, t_years: float, iv: float, r: float):
    """Returns delta in [-1, 0], or None if inputs are unusable."""
    cd = call_delta(spot, strike, t_years, iv, r)
    if cd is None:
        return None
    if t_years <= 0:
        return -1.0 if spot < strike else 0.0
    return cd - 1.0
