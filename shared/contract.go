// Package hostcontract shares model policy between the browser and native companion.
package hostcontract

import (
	"embed"
	"encoding/json"
)

//go:generate go run ../native-host/cmd/build --generate-only

//go:embed host-contract.json
var Files embed.FS

var Data, _ = Files.ReadFile("host-contract.json")

type Definition struct {
	Tools                                              []map[string]any
	Efforts                                            []string
	BaseInstructions, AskInstructions, ActInstructions string
	AppName, HostName, ExtensionOrigin                 string
	Limits                                             struct{ ContextBytes, HistoryBytes, CompactionBytes, PromptBytes, ResponseBytes, DeltaChars, ActContextBytes int }
}

var Contract Definition

func init() {
	if err := json.Unmarshal(Data, &Contract); err != nil {
		panic("invalid embedded host contract")
	}
}
