# Switch between mm and inches

Click **mm / in** in the toolbar. Every length on screen switches at once.

The app stores everything in millimetres; the button only changes what you see and type.
So you can switch at any time, and a saved project opens the same either way.

## Feeds per minute or per second

The **/min / /s** button beside it switches how feed rates are shown: per minute
(**mm/min** or **in/min**) or per second (**mm/s** or **in/s**). It changes every feed on
screen at once: the tool library, Setup, the simulator, the export review and the Machine tab.

Pick whichever matches the numbers you think in. Tool makers' charts and G-code use per
minute; if you're used to a 3D printer, per second may feel more natural. 1000 mm/min is
16.7 mm/s.

Like **mm / in**, it changes only what you see and type. The G-code is always written per
minute, because that is all FluidNC and Grbl accept.

## Typing lengths

In any length field you can type:

- a fraction: **1/8** or **1-1/2**;
- a calculation, starting with **=**: **=25.4/8**.

## The G-code's units

The units in the G-code file come from the post-processor's **Unit mode**, not from this
button. See [Post-processor settings](../reference/post-processor.md#profile-fields).

**Related:** [Set up your stock](set-up-your-stock.md)
