import mongoose, { Schema, Document } from 'mongoose';
import { IScore } from '@whalo/shared';

export interface ScoreDocument extends IScore, Document {}

const scoreSchema = new Schema<ScoreDocument>(
  {
    playerId: {
      type: String,
      required: true,
      index: true,
    },
    score: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    toJSON: {
      transform(_doc, ret)
      {
        const { _id, __v, ...rest } = ret;
        return rest;
      },
    },
  }
);

scoreSchema.index({ score: -1 });
scoreSchema.index({ playerId: 1, score: -1 });
scoreSchema.index({ playerId: 1, createdAt: 1 }, { unique: true });

export const Score = mongoose.model<ScoreDocument>('Score', scoreSchema);
