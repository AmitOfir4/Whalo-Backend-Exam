import { Router } from 'express';
import { validate, validateQuery } from '@whalo/shared';
import { createPlayerSchema, updatePlayerSchema, resolvePlayersQuerySchema } from '../validators/player.validator';
import {
  createPlayer,
  resolvePlayersByIds,
  getPlayer,
  updatePlayer,
  deletePlayer,
} from '../controllers/player.controller';

const router = Router();

router.post('/', validate(createPlayerSchema), createPlayer);
// GET /players is batch-resolution only: `?ids=a,b,c` → {data: [{playerId, username}]}.
// There is deliberately no "list all players" endpoint — that's a data-dump
// shape no product surface needs and it makes the service cheaper to operate.
router.get('/', validateQuery(resolvePlayersQuerySchema), resolvePlayersByIds);
router.get('/:playerId', getPlayer);
router.put('/:playerId', validate(updatePlayerSchema), updatePlayer);
router.delete('/:playerId', deletePlayer);

export default router;
