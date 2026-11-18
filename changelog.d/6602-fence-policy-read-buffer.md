section: Fixed
- The write fence no longer refuses every one-PR story once `PROJECT-DEFINITION` passes 1 MiB (its merge-base read now uses the shared 64 MiB ceiling), and a failed policy read now refuses the write with the reason instead of passing as an empty fence. Refs #6602.
