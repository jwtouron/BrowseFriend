//go:build candidate_keeper

package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"

	keeper "github.com/agberohq/keeper"
	"github.com/vmihailenco/msgpack/v5"
	bolt "go.etcd.io/bbolt"
)

func TestKeeperStoredCiphertextTampering(t *testing.T) {
	dir := testDirectory(t)
	seed(t, testStore(t, "keeper", dir, fixedKey), 4096)
	path := filepath.Join(dir, "account.db")
	change := func() []byte {
		db, err := bolt.Open(path, 0600, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()
		var damaged []byte
		if err := db.Update(func(tx *bolt.Tx) error {
			b := tx.Bucket([]byte("vault")).Bucket([]byte("browsefriend"))
			var secret keeper.Secret
			if err := msgpack.Unmarshal(b.Get([]byte("account")), &secret); err != nil {
				return err
			}
			secret.Ciphertext[len(secret.Ciphertext)-1] ^= 1
			damaged, err = msgpack.Marshal(&secret)
			if err != nil {
				return err
			}
			return b.Put([]byte("account"), damaged)
		}); err != nil {
			t.Fatal(err)
		}
		return damaged
	}
	damaged := change()
	if err := testStore(t, "keeper", dir, fixedKey).WithLock(context.Background(), func(_ *account, _ saveAccount) error { t.Fatal("forged credential accepted"); return nil }); err == nil {
		t.Fatal("integrity failure ignored")
	}
	db, err := bolt.Open(path, 0600, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.View(func(tx *bolt.Tx) error {
		actual := tx.Bucket([]byte("vault")).Bucket([]byte("browsefriend")).Get([]byte("account"))
		if !bytes.Equal(actual, damaged) {
			t.Fatal("damaged credential overwritten")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
}
