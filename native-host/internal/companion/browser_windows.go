package companion

import (
	"context"

	"golang.org/x/sys/windows"
)

func openBrowser(ctx context.Context, url string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	address, err := windows.UTF16PtrFromString(url)
	if err == nil {
		err = windows.ShellExecute(0, windows.StringToUTF16Ptr("open"), address, nil, nil, windows.SW_SHOWNORMAL)
	}
	if err != nil {
		return failure("browser_unavailable", "The browser could not be opened. Check your default browser and try again.", false)
	}
	return nil
}
