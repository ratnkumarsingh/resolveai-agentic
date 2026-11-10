-- Keep the original seeded invoice incident and remove accidental duplicate copies.
DELETE FROM incidents
 WHERE title = 'Invoice PDF uploads failing'
	AND "key" <> 'INC-1045';
