# The Odds API — batch client for RoliBot (https://the-odds-api.com)
# One h2h sweep + one props call per slate game; never per-player.

from __future__ import annotations

import json
import urllib.parse
import urllib.request
from collections import defaultdict
from typing import Callable, DefaultDict, Dict, List, Optional, Set, Tuple

BASE = "https://api.the-odds-api.com/v4/sports"

# Odds API home_team / away_team strings → NBA tricode (nba_api full_name + common aliases)
ODDS_API_TEAM_MAP: Dict[str, str] = {
    "Atlanta Hawks": "ATL",
    "Boston Celtics": "BOS",
    "Brooklyn Nets": "BKN",
    "Charlotte Hornets": "CHA",
    "Chicago Bulls": "CHI",
    "Cleveland Cavaliers": "CLE",
    "Dallas Mavericks": "DAL",
    "Denver Nuggets": "DEN",
    "Detroit Pistons": "DET",
    "Golden State Warriors": "GSW",
    "Houston Rockets": "HOU",
    "Indiana Pacers": "IND",
    "Los Angeles Clippers": "LAC",
    "Los Angeles Lakers": "LAL",
    "Memphis Grizzlies": "MEM",
    "Miami Heat": "MIA",
    "Milwaukee Bucks": "MIL",
    "Minnesota Timberwolves": "MIN",
    "New Orleans Pelicans": "NOP",
    "New York Knicks": "NYK",
    "Oklahoma City Thunder": "OKC",
    "Orlando Magic": "ORL",
    "Philadelphia 76ers": "PHI",
    "Phoenix Suns": "PHX",
    "Portland Trail Blazers": "POR",
    "Sacramento Kings": "SAC",
    "San Antonio Spurs": "SAS",
    "Toronto Raptors": "TOR",
    "Utah Jazz": "UTA",
    "Washington Wizards": "WAS",
}

# Broadcast / API variants not identical to nba_api full_name
ODDS_API_TEAM_ALIASES: Dict[str, str] = {
    "LA Clippers": "LAC",
    "LA Lakers": "LAL",
    "Sixers": "PHI",
    "Philadelphia Sixers": "PHI",
}

MARKET_TO_STAT = {
    "player_points": "PTS",
    "player_rebounds": "REB",
    "player_assists": "AST",
    "player_threes": "FG3M",
}

BOOK_PREF_ORDER = (
    "draftkings",
    "fanduel",
    "betmgm",
    "williamhill_us",
    "caesars",
    "pointsbetus",
    "wynnbet",
    "barstool",
    "betrivers",
    "unibet_us",
    "bovada",
    "mybookieag",
    "betonlineag",
    "lowvig",
)

_LAST_QUOTA: Dict[str, Optional[str]] = {"remaining": None, "used": None}


def get_last_quota() -> Dict[str, Optional[str]]:
    return dict(_LAST_QUOTA)


def american_to_implied_prob(price: int) -> float:
    if price > 0:
        return 100.0 / (float(price) + 100.0)
    a = abs(float(price))
    return a / (a + 100.0)


def log_odds_api_quota(headers: Any) -> None:
    """Read X-Requests-* headers; warn if remaining < 50."""
    if headers is None:
        return
    get = headers.get if hasattr(headers, "get") else lambda k, d=None: None
    rem = get("x-requests-remaining") or get("X-Requests-Remaining")
    used = get("x-requests-used") or get("X-Requests-Used")
    _LAST_QUOTA["remaining"] = rem
    _LAST_QUOTA["used"] = used
    if rem is None:
        return
    try:
        r = int(rem)
    except (TypeError, ValueError):
        print(f"  The Odds API quota: remaining={rem!r}  used={used!r}")
        return
    if r < 50:
        print(f"  ! The Odds API: only {r} requests remaining this billing cycle (used={used}).")
    else:
        print(f"  The Odds API quota: {r} requests remaining (used={used}).")


def team_name_to_abbr(name: str) -> Optional[str]:
    if not name:
        return None
    s = name.strip()
    if s in ODDS_API_TEAM_ALIASES:
        return ODDS_API_TEAM_ALIASES[s]
    if s in ODDS_API_TEAM_MAP:
        return ODDS_API_TEAM_MAP[s]
    low = s.lower()
    for full, ab in ODDS_API_TEAM_MAP.items():
        if full.lower() == low:
            return ab
    for alias, ab in ODDS_API_TEAM_ALIASES.items():
        if alias.lower() == low:
            return ab
    return None


def _http_json(url: str) -> Tuple[Any, dict]:
    req = urllib.request.Request(url, headers={"User-Agent": "RoliBotNBA/5.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        body = resp.read().decode("utf-8", "replace")
        hdrs = {k.lower(): v for k, v in resp.headers.items()}
    log_odds_api_quota(hdrs)
    data = json.loads(body)
    return data, hdrs


def _sort_bookmakers(bookmakers: List[dict]) -> List[dict]:
    rank = {k: i for i, k in enumerate(BOOK_PREF_ORDER)}

    def key(bm: dict) -> Tuple[int, str]:
        k = (bm.get("key") or "").lower()
        return (rank.get(k, 999), k)

    return sorted(bookmakers or [], key=key)


def _h2h_from_bookmaker(
    bm: dict, home_full: str, away_full: str
) -> Optional[Tuple[int, int]]:
    for m in bm.get("markets") or []:
        if m.get("key") != "h2h":
            continue
        by_name: Dict[str, int] = {}
        for o in m.get("outcomes") or []:
            nm = (o.get("name") or "").strip()
            pr = o.get("price")
            if nm and pr is not None:
                try:
                    by_name[nm] = int(pr)
                except (TypeError, ValueError):
                    pass
        hm = by_name.get(home_full)
        am = by_name.get(away_full)
        if hm is not None and am is not None:
            return hm, am
    return None


def fetch_real_odds(
    api_key: str, sport: str = "basketball_nba"
) -> Tuple[Dict[frozenset, dict], Optional[str]]:
    """
    GET /v4/sports/{sport}/odds with h2h, american.
    Returns dict: frozenset({away_abbr, home_abbr}) -> {
        home_abbr, away_abbr, home_ml, away_ml, bookmakers (raw), event_id, book_key
    }
    """
    params = urllib.parse.urlencode(
        {
            "apiKey": api_key,
            "regions": "us",
            "markets": "h2h",
            "oddsFormat": "american",
        }
    )
    url = f"{BASE}/{sport}/odds/?{params}"
    try:
        data, _ = _http_json(url)
    except Exception as e:
        return {}, str(e)[:220]
    if not isinstance(data, list):
        return {}, "unexpected h2h response shape"
    out: Dict[frozenset, dict] = {}
    for ev in data:
        hf = (ev.get("home_team") or "").strip()
        af = (ev.get("away_team") or "").strip()
        ha = team_name_to_abbr(hf)
        aa = team_name_to_abbr(af)
        if not ha or not aa:
            continue
        eid = ev.get("id")
        bms = _sort_bookmakers(ev.get("bookmakers") or [])
        home_ml = away_ml = None
        book_key = ""
        for bm in bms:
            pair = _h2h_from_bookmaker(bm, hf, af)
            if pair:
                home_ml, away_ml = pair
                book_key = (bm.get("key") or "").lower()
                break
        if home_ml is None or away_ml is None:
            continue
        key = frozenset({ha.upper(), aa.upper()})
        out[key] = {
            "home_abbr": ha.upper(),
            "away_abbr": aa.upper(),
            "home_ml": home_ml,
            "away_ml": away_ml,
            "bookmakers": ev.get("bookmakers") or [],
            "event_id": eid,
            "book_key": book_key,
        }
    return out, None


def fetch_real_props(
    api_key: str,
    event_ids: List[str],
    normalize_name_fn: Callable[[str], str],
    sport: str = "basketball_nba",
) -> Tuple[DefaultDict[Tuple[str, str], List[Tuple[float, int, str, str]]], DefaultDict[str, Set[str]]]:
    """
    For each event id (tonight's slate only): GET event odds with player prop markets.
    Returns:
      buckets (normalized_name, stat) -> [(point, american_over, bookmaker_key, bookmaker_title), ...]
      names_by_stat: stat -> set of normalized names seen (for fuzzy match)
    """
    buckets: DefaultDict[Tuple[str, str], List[Tuple[float, int, str, str]]] = defaultdict(list)
    names_by_stat: DefaultDict[str, Set[str]] = defaultdict(set)
    markets = "player_points,player_rebounds,player_assists,player_threes"
    for eid in event_ids:
        if not eid:
            continue
        params = urllib.parse.urlencode(
            {
                "apiKey": api_key,
                "regions": "us",
                "markets": markets,
                "oddsFormat": "american",
            }
        )
        url = f"{BASE}/{sport}/events/{urllib.parse.quote(str(eid), safe='')}/odds?{params}"
        try:
            data, _ = _http_json(url)
        except Exception as e:
            print(f"  ! The Odds API props for event {eid}: {e}")
            continue
        if not isinstance(data, dict):
            continue
        bms = _sort_bookmakers(data.get("bookmakers") or [])
        for bm in bms:
            bk_key = (bm.get("key") or "").strip().lower()
            bk_title = (bm.get("title") or bm.get("key") or "").strip()
            for market in bm.get("markets") or []:
                mk = market.get("key") or ""
                stat = MARKET_TO_STAT.get(mk)
                if not stat:
                    continue
                for oc in market.get("outcomes") or []:
                    if str(oc.get("name") or "").strip().lower() != "over":
                        continue
                    desc = (oc.get("description") or "").strip()
                    if not desc:
                        continue
                    pt = oc.get("point")
                    pr = oc.get("price")
                    if pt is None or pr is None:
                        continue
                    try:
                        fpt = float(pt)
                        ipr = int(pr)
                    except (TypeError, ValueError):
                        continue
                    nk = normalize_name_fn(desc)
                    if not nk:
                        continue
                    buckets[(nk, stat)].append((fpt, ipr, bk_key, bk_title))
                    names_by_stat[stat].add(nk)
    return buckets, names_by_stat
