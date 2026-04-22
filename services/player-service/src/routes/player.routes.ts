import { Router } from 'express';
import { validate } from '@whalo/shared';
import { createPlayerSchema, updatePlayerSchema } from '../validators/player.validator';
import {
  createPlayer,
  getPlayer,
  updatePlayer,
  deletePlayer,
} from '../controllers/player.controller';

const router = Router();

router.post('/', validate(createPlayerSchema), createPlayer);
router.get('/:playerId', getPlayer);
router.put('/:playerId', validate(updatePlayerSchema), updatePlayer);
router.delete('/:playerId', deletePlayer);

export default router;
