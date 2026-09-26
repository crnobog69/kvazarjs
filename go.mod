module kvazar

go 1.24

require (
	github.com/cartridge-gg/discordgo v0.29.1-dave.25
	github.com/joho/godotenv v1.5.1
	layeh.com/gopus v0.0.0-20210501142526-1ee02d434e32
)

require (
	github.com/gorilla/websocket v1.4.2 // indirect
	golang.org/x/crypto v0.0.0-20210421170649-83a5a9bb288b // indirect
	golang.org/x/sys v0.0.0-20201119102817-f84b799fce68 // indirect
)

replace github.com/cartridge-gg/discordgo => ./third_party/discordgo

