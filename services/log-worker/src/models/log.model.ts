import mongoose, { Schema, Document } from 'mongoose';
import { ILog } from '@whalo/shared';

export interface LogDocument extends ILog, Document {}

const logSchema = new Schema<LogDocument>(
  {
    playerId: {
      type: String,
      required: true,
      index: true,
    },
    logData: {
      type: String,
      required: true,
    },
    receivedAt: {
      type: Date,
      required: true,
    },
    processedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: false,
    toJSON: {
      transform(_doc, ret) {
        const { _id, __v, ...rest } = ret;
        return rest;
      },
    },
  }
);

export const Log = mongoose.model<LogDocument>('Log', logSchema);
