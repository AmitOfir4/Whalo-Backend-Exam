import mongoose, { Schema, Document } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { IPlayer } from '@whalo/shared';

export interface PlayerDocument extends Omit<IPlayer, 'playerId'>, Document {
  playerId: string;
}

const playerSchema = new Schema<PlayerDocument>(
  {
    playerId: {
      type: String,
      default: uuidv4,
      unique: true,
      index: true
    },
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true
    }
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret)
      {
        const { _id, __v, ...rest } = ret;
        return rest;
      },
    },
  }
);

export const Player = mongoose.model<PlayerDocument>('Player', playerSchema);
