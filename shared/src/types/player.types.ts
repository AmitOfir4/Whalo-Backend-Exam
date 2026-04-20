export interface IPlayer {
  playerId: string;
  username: string;
  email: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePlayerDto {
  username: string;
  email: string;
}

export interface UpdatePlayerDto {
  username?: string;
  email?: string;
}
