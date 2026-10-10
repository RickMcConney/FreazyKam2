# Fix a weak WiFi link

1. Check the signal in the Connection section. Aim for **green** (60 % or more).
2. Move the controller's antenna away from metal.
3. Add a WiFi extender near the machine.
4. Set your router's 2.4 GHz channel to **1** or **11** (not Auto).

## Make the controller use the extender

1. Give the extender's 2.4 GHz network its own name.
2. In the Machine tab console, type:

   ```
   $Sta/SSID=Your_Extender_Name
   $Bye
   ```

   Add `$Sta/Password=…` before `$Bye` if the password is different.

Wrong name or password? The controller starts its own **FluidNC** network. Join it from
your phone and fix the settings there.

**Related:** [Connection problems](../reference/messages.md#machine-connection)
