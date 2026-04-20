export interface IScore {
  playerId: string;
  username: string;
  score: number;
  createdAt: Date;
}

export interface CreateScoreDto {
  playerId: string;
  score: number;
}

export interface LeaderboardEntry {
  playerId: string;
  username: string;
  totalScore: number;
}

export interface PaginationQuery {
  page?: number;
  limit?: number;
}
