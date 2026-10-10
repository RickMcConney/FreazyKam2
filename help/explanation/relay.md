# Why the machine needs a relay file

FreazyKam is a **secure** website (`https://`). Your FluidNC controller is a **plain**
device (`http://`) on your WiFi. Browsers don't let secure pages talk to plain ones.

```
  FreazyKam (https)  ──✗──►  Controller (http)       blocked

  FreazyKam (https)  ──►  Relay window  ──►  Controller
                          (http, lives on            allowed
                           the controller)
```

The **relay** is a tiny page stored on the controller. FreazyKam opens it in a small window
and passes messages through. Because the relay comes from the controller, the browser lets
it talk to the controller.

## Why two file names

- **FluidNC v4** serves any file on its flash as a page, so the relay can be called
  `freazyKam.html`.
- **FluidNC v3** downloads files instead of showing them, except its "page not found" page,
  `404.htm`. So on v3 the relay pretends to be that page.

FreazyKam opens the same address either way.

## Why connect before a job

FluidNC won't serve pages while the machine is moving. If you aren't connected when the job
starts, the relay can't open until it ends. A running job keeps going if the link drops.

## Is it safe?

The relay only takes instructions from FreazyKam. On v3, a mistyped address shows the relay
instead of "not found". That's harmless.

**How-to:** [Install the relay](../how-to/install-the-relay.md)
