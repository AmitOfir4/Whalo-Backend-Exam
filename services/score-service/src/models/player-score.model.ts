import mongoose, { Schema, Document } from 'mongoose';

export interface PlayerScoreDocument extends Document {
  playerId: string;
  username: string;
  totalScore: number;
  gamesPlayed: number;
}

const playerScoreSchema = new Schema<PlayerScoreDocument>(
  {
    playerId: {
      type: String,
      required: true,
      unique: true,
    },
    username: {
      type: String,
      required: true,
    },
    totalScore: {
      type: Number,
      required: true,
      default: 0,
    },
    gamesPlayed: {
      type: Number,
      required: true,
      default: 0,
    },
  },
  {
    timestamps: false,
    toJSON: {
      transform(_doc, ret)
      {
        const { _id, __v, ...rest } = ret;
        return rest;
      },
    },
  }
);

playerScoreSchema.index({ totalScore: -1 });

export const PlayerScore = mongoose.model<PlayerScoreDocument>('PlayerScore', playerScoreSchema);
