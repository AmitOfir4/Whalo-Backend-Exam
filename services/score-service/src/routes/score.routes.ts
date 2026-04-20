import { Router } from 'express';
import { validate } from '@whalo/shared';
import { createScoreSchema } from '../validators/score.validator';
import { submitScore, getTopScores } from '../controllers/score.controller';

const router = Router();

router.post('/', validate(createScoreSchema), submitScore);
router.get('/top', getTopScores);

export default router;
