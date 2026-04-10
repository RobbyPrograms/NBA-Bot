import {
  fetchNbaScoreboardForDate,
  findBoardGame,
  isFinalStatus,
  winnerAbbr,
  type NbaBoardGame,
} from "@/lib/nba-dated-scoreboard";

export type MlPickGrade = {
  home_abbr: string;
  away_abbr: string;
  home_name?: string;
  away_name?: string;
  pick_abbr: string;
  pick_name?: string;
  pick_side?: string;
  home_score: number | null;
  away_score: number | null;
  winner_abbr: string | null;
  status_text: string;
  is_final: boolean;
  pick_correct: boolean | null;
  note?: string;
};

export type MlGradingResult = {
  slate_date: string;
  games: MlPickGrade[];
  board_games_found: number;
  scoreboard_error?: string;
};

type GameJson = {
  home_abbr?: string;
  away_abbr?: string;
  home_name?: string;
  away_name?: string;
  pick_abbr?: string;
  pick_name?: string;
  pick_side?: string;
};

function gradeOne(g: GameJson, board: NbaBoardGame[]): MlPickGrade {
  const home_abbr = String(g.home_abbr ?? "");
  const away_abbr = String(g.away_abbr ?? "");
  const pick_abbr = String(g.pick_abbr ?? "").toUpperCase();
  const row = findBoardGame(board, home_abbr, away_abbr);
  if (!row) {
    return {
      home_abbr,
      away_abbr,
      home_name: g.home_name,
      away_name: g.away_name,
      pick_abbr,
      pick_name: g.pick_name,
      pick_side: g.pick_side,
      home_score: null,
      away_score: null,
      winner_abbr: null,
      status_text: "",
      is_final: false,
      pick_correct: null,
      note: "No matching game on NBA scoreboard for this date (wrong date or schedule mismatch).",
    };
  }
  const fin = isFinalStatus(row.statusText);
  const win = winnerAbbr(row);
  let pick_correct: boolean | null = null;
  let note: string | undefined;
  if (!fin) {
    note = "Game not final yet.";
  } else if (!win) {
    note = "Tie or no winner.";
  } else if (!pick_abbr) {
    note = "No pick in report.";
  } else {
    pick_correct = pick_abbr === win;
  }

  return {
    home_abbr,
    away_abbr,
    home_name: g.home_name,
    away_name: g.away_name,
    pick_abbr,
    pick_name: g.pick_name,
    pick_side: g.pick_side,
    home_score: row.homeScore,
    away_score: row.awayScore,
    winner_abbr: win,
    status_text: row.statusText,
    is_final: fin,
    pick_correct,
    note,
  };
}

/** Use when the scoreboard for `slateDate` is already loaded (avoids duplicate fetches). */
export function gradeMlPicksWithBoard(
  slateDate: string,
  games: unknown,
  board: NbaBoardGame[]
): MlGradingResult {
  if (!Array.isArray(games)) {
    return {
      slate_date: slateDate,
      games: [],
      board_games_found: board.length,
      scoreboard_error: "Report has no games array.",
    };
  }
  const grades = (games as GameJson[]).map((g) => gradeOne(g, board));
  return {
    slate_date: slateDate,
    games: grades,
    board_games_found: board.length,
  };
}

/** Grade moneyline picks in a stored report's `games` array vs NBA box score for that slate date. */
export async function gradeMlPicksForReport(
  slateDate: string,
  games: unknown
): Promise<MlGradingResult> {
  if (!Array.isArray(games)) {
    return {
      slate_date: slateDate,
      games: [],
      board_games_found: 0,
      scoreboard_error: "Report has no games array.",
    };
  }

  let board: NbaBoardGame[] = [];
  try {
    board = await fetchNbaScoreboardForDate(slateDate);
  } catch (e) {
    return {
      slate_date: slateDate,
      games: [],
      board_games_found: 0,
      scoreboard_error: e instanceof Error ? e.message : "Scoreboard fetch failed.",
    };
  }

  return gradeMlPicksWithBoard(slateDate, games, board);
}
