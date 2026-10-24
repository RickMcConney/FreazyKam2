# Restart a job that stopped part way

A broken bit, a power cut, a cancel. Restart from where it stopped instead of the top.

1. **Simulate** the job and open the G-code viewer (document icon).
2. Find the line where it stopped: scrub the simulator, or click the line.
3. Pause, then click **Resume from line N** at the top of the viewer.
4. Choose a restart. The simulator jumps to show where it begins.

   | Restart | Begins |
   |---|---|
   | Carry on from where it stopped | At that line, straight down through the existing cut |
   | Redo the interrupted pass | Where the tool last came down |
   | Recut this part from its start | The part's first pass (cut passes run through air) |
   | Skip to the next part | The next part. Recut this one later |

5. Router switched by hand? Tick **Pause after the spindle command**.
6. Click **Download resume file**. Run it like any job.

**Zero X, Y and Z exactly as for the original run.** If the machine lost power or alarmed,
or the stock moved, find zero again first.

The file goes up to safe Z, across, then down at plunge feed, then runs the original
program from that line. It works on G-code from any CAM program.

**Can't resume?** The panel says why: relative moves, cutter compensation, a canned cycle,
G92/G10, rotary axes, or a line before X, Y and Z were set.

**Related:** [Pause, stop or end a job early](stop-a-job.md) · [Simulate a job](simulate-a-job.md)
