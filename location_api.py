"""
KNIGHT — location_api.py
========================
A small FastAPI service that turns raw GPS coordinates into a *city*, and
decides when the user has moved somewhere new enough to be worth asking about.

Why this is a separate service and not more code in the main server:
  Reverse geocoding is slow (a network round-trip to a third-party provider)
  and rate-limited. Keeping it separate means a slow or rate-limited geocoder
  can never take down sign-in, chat, or anything else on the main app.

PROVIDERS
---------
Two are supported. It picks automatically based on whether you set a key:

  * OpenCage   — set OPENCAGE_KEY. Paid/free-tier, needs an API key, generous
                 limits, good city resolution worldwide. Preferred if present.
  * Nominatim  — OpenStreetMap's free geocoder. NO API KEY NEEDED, so this is
                 the default fallback and the service works out of the box.
                 Hard-limited to ~1 request/second, so the cache below is not
                 an optimization, it is a requirement for staying unblocked.

ENDPOINTS
---------
  GET  /health                      — liveness + which provider is active
  GET  /geo/reverse?lat=&lng=       — coordinates -> city
  POST /geo/check                   — coordinates + known home city -> should we prompt?
  GET  /geo/city-key?name=          — normalize a city name into a stable key

Run locally:  uvicorn location_api:app --reload --port 8100
"""

import os
import re
import time
import math
import asyncio
import unicodedata
from typing import Optional, Dict, Any

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

app = FastAPI(title="Knight Location API", version="1.0.0")

# The browser calls this service directly from a different origin than the main
# app, so CORS has to be open. Lock ALLOWED_ORIGINS down to your real domain in
# production rather than leaving the "*" default.
_origins = os.environ.get("ALLOWED_ORIGINS", "*")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if _origins == "*" else [o.strip() for o in _origins.split(",")],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

OPENCAGE_KEY = os.environ.get("OPENCAGE_KEY", "").strip()
PROVIDER = "opencage" if OPENCAGE_KEY else "nominatim"

# Nominatim's usage policy REQUIRES a real identifying User-Agent. Requests
# without one get blocked, so set CONTACT_EMAIL in production.
CONTACT_EMAIL = os.environ.get("CONTACT_EMAIL", "knight-app@example.com")
USER_AGENT = f"KnightRealms/1.0 ({CONTACT_EMAIL})"

# How far the user must move before we even bother re-geocoding. Phones jitter
# GPS by tens of metres while sitting still; without this the app would burn
# through the rate limit re-asking "what city is this?" about the same spot.
MIN_MOVE_KM = float(os.environ.get("MIN_MOVE_KM", "5"))

# ----------------------------------------------------------------------------
# Cache — coordinates rounded to ~1km, so everyone in the same neighbourhood
# shares one cached lookup instead of each triggering their own API call.
# ----------------------------------------------------------------------------
_CACHE: Dict[str, Any] = {}
_CACHE_TTL = 60 * 60 * 24  # a city's name does not change; a day is plenty
_last_call_at = 0.0
_rate_lock = asyncio.Lock()


def _cache_key(lat: float, lng: float) -> str:
    return f"{round(lat, 2)},{round(lng, 2)}"


def _cache_get(lat: float, lng: float) -> Optional[dict]:
    hit = _CACHE.get(_cache_key(lat, lng))
    if hit and time.time() - hit["at"] < _CACHE_TTL:
        return hit["value"]
    return None


def _cache_put(lat: float, lng: float, value: dict) -> None:
    _CACHE[_cache_key(lat, lng)] = {"at": time.time(), "value": value}


def city_key(name: str) -> str:
    """
    Turn a display name into a stable comparison key.

    This matters more than it looks. Geocoders are inconsistent about the same
    place: "Ghāziābād", "Ghaziabad", "GHAZIABAD  " are all the same city, and
    comparing raw strings would tell the user they had moved to a new city
    every time the provider changed its mind about the diacritics. Stripping
    accents and punctuation makes that comparison reliable.
    """
    if not name:
        return ""
    decomposed = unicodedata.normalize("NFKD", name)
    ascii_only = "".join(c for c in decomposed if not unicodedata.combining(c))
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_only.lower()).strip("-")
    return slug


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371.0
    d_lat = math.radians(lat2 - lat1)
    d_lng = math.radians(lng2 - lng1)
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(d_lng / 2) ** 2
    )
    return r * 2 * math.asin(math.sqrt(a))


def _validate(lat: float, lng: float) -> None:
    if not (-90 <= lat <= 90) or not (-180 <= lng <= 180):
        raise HTTPException(status_code=400, detail="lat must be -90..90 and lng must be -180..180")


async def _respect_rate_limit() -> None:
    """Nominatim allows ~1 req/sec. Serialize and space out calls to stay legal."""
    global _last_call_at
    if PROVIDER != "nominatim":
        return
    async with _rate_lock:
        gap = time.time() - _last_call_at
        if gap < 1.1:
            await asyncio.sleep(1.1 - gap)
        _last_call_at = time.time()


async def _reverse_opencage(lat: float, lng: float) -> dict:
    url = "https://api.opencagedata.com/geocode/v1/json"
    params = {"q": f"{lat},{lng}", "key": OPENCAGE_KEY, "no_annotations": 1, "limit": 1}
    async with httpx.AsyncClient(timeout=8.0) as client:
        r = await client.get(url, params=params)
    if r.status_code == 401:
        raise HTTPException(status_code=502, detail="OpenCage rejected the API key (check OPENCAGE_KEY)")
    if r.status_code == 402:
        raise HTTPException(status_code=502, detail="OpenCage quota exhausted for today")
    r.raise_for_status()
    results = r.json().get("results") or []
    if not results:
        raise HTTPException(status_code=404, detail="No place found at those coordinates")
    c = results[0].get("components", {})
    city = c.get("city") or c.get("town") or c.get("village") or c.get("municipality") or c.get("county") or ""
    return {
        "city": city,
        "region": c.get("state") or c.get("region") or "",
        "country": c.get("country") or "",
        "country_code": (c.get("country_code") or "").upper(),
        "formatted": results[0].get("formatted", ""),
    }


async def _reverse_nominatim(lat: float, lng: float) -> dict:
    await _respect_rate_limit()
    url = "https://nominatim.openstreetmap.org/reverse"
    params = {"lat": lat, "lon": lng, "format": "jsonv2", "zoom": 10, "addressdetails": 1}
    async with httpx.AsyncClient(timeout=8.0, headers={"User-Agent": USER_AGENT}) as client:
        r = await client.get(url, params=params)
    if r.status_code == 403:
        raise HTTPException(status_code=502, detail="Nominatim blocked the request — set a real CONTACT_EMAIL")
    r.raise_for_status()
    body = r.json()
    if "error" in body:
        raise HTTPException(status_code=404, detail="No place found at those coordinates")
    a = body.get("address", {})
    city = (
        a.get("city") or a.get("town") or a.get("village")
        or a.get("municipality") or a.get("county") or a.get("state_district") or ""
    )
    return {
        "city": city,
        "region": a.get("state") or "",
        "country": a.get("country") or "",
        "country_code": (a.get("country_code") or "").upper(),
        "formatted": body.get("display_name", ""),
    }


async def reverse_geocode(lat: float, lng: float) -> dict:
    _validate(lat, lng)
    cached = _cache_get(lat, lng)
    if cached:
        return {**cached, "cached": True}

    try:
        place = await _reverse_opencage(lat, lng) if PROVIDER == "opencage" else await _reverse_nominatim(lat, lng)
    except HTTPException:
        raise
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Geocoding provider timed out")
    except Exception as exc:  # network blips, malformed payloads, provider outages
        raise HTTPException(status_code=502, detail=f"Geocoding failed: {exc}")

    if not place.get("city"):
        # Middle of the ocean, Antarctica, unmapped desert — a real outcome, not a bug.
        raise HTTPException(status_code=404, detail="Could not resolve a city for those coordinates")

    place["city_key"] = city_key(place["city"])
    place["provider"] = PROVIDER
    _cache_put(lat, lng, place)
    return {**place, "cached": False}


# ----------------------------------------------------------------------------
# Models
# ----------------------------------------------------------------------------
class CheckRequest(BaseModel):
    lat: float = Field(..., description="Current latitude from the browser")
    lng: float = Field(..., description="Current longitude from the browser")
    home_city_key: Optional[str] = Field(None, description="The saved city_key from the user's profile")
    home_lat: Optional[float] = Field(None, description="Saved home latitude, if known")
    home_lng: Optional[float] = Field(None, description="Saved home longitude, if known")


# ----------------------------------------------------------------------------
# Routes
# ----------------------------------------------------------------------------
@app.get("/health")
async def health():
    return {
        "ok": True,
        "service": "knight-location-api",
        "provider": PROVIDER,
        "key_configured": bool(OPENCAGE_KEY),
        "cached_places": len(_CACHE),
    }


@app.get("/geo/city-key")
async def get_city_key(name: str = Query(..., description="A city display name to normalize")):
    return {"name": name, "city_key": city_key(name)}


@app.get("/geo/reverse")
async def geo_reverse(lat: float = Query(...), lng: float = Query(...)):
    """Coordinates in, city out. This is what the signup Location button calls."""
    return await reverse_geocode(lat, lng)


@app.post("/geo/check")
async def geo_check(req: CheckRequest):
    """
    Called on app open. Answers one question: has this user moved to a new city,
    and should we interrupt them to ask about it?

    We deliberately return `should_prompt` rather than letting the frontend
    decide, so the "don't nag the user" rules live in exactly one place.
    """
    # Cheap short-circuit: if we know where home is and they have barely moved,
    # skip the geocode entirely. Saves an API call on the overwhelming majority
    # of opens, since most of the time the user is exactly where they were.
    if req.home_lat is not None and req.home_lng is not None:
        moved_km = haversine_km(req.home_lat, req.home_lng, req.lat, req.lng)
        if moved_km < MIN_MOVE_KM:
            return {
                "is_new_city": False,
                "should_prompt": False,
                "moved_km": round(moved_km, 2),
                "reason": "still within the home radius",
            }

    place = await reverse_geocode(req.lat, req.lng)
    current_key = place["city_key"]
    is_new = bool(req.home_city_key) and current_key != req.home_city_key
    first_time = not req.home_city_key

    moved_km = None
    if req.home_lat is not None and req.home_lng is not None:
        moved_km = round(haversine_km(req.home_lat, req.home_lng, req.lat, req.lng), 2)

    if first_time:
        message = f"Set {place['city']} as your home city?"
    elif is_new:
        message = f"Looks like you're in {place['city']} now. Make this your home city?"
    else:
        message = f"Welcome back to {place['city']}."

    return {
        "current": place,
        "is_new_city": is_new,
        "first_time": first_time,
        # Only interrupt when there is genuinely something to decide.
        "should_prompt": is_new or first_time,
        "moved_km": moved_km,
        "message": message,
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8100")))
