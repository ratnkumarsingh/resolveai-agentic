-- Keep the original seeded invoice incident and remove accidental duplicate copies.
DELETE FROM incidents
 WHERE title = 'Invoice PDF uploads failing'
   AND id <> (
	   SELECT id
		 FROM incidents
		WHERE title = 'Invoice PDF uploads failing'
		ORDER BY created_at ASC, id ASC
		LIMIT 1
   );
