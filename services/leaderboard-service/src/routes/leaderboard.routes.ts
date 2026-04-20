import { Router } from 'express';
import { validateQuery } from '@whalo/shared';
import { leaderboardQuerySchema } from '../validators/leaderboard.validator';
import { getLeaderboard } from '../controllers/leaderboard.controller';

const router = Router();

router.get('/leaderboard', validateQuery(leaderboardQuerySchema), getLeaderboard);

export default router;
