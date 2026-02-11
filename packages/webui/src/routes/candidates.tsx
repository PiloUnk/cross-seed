import { useEffect, useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useSuspenseQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Page } from '@/components/Page';
import { Button } from '@/components/ui/button';
import { formatRelativeTime } from '@/lib/time';
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react';

export const Route = createFileRoute('/candidates')({
  component: CandidatesPage,
});

const PAGE_SIZE = 25;

function CandidatesPage() {
  const trpc = useTRPC();
  const [page, setPage] = useState(0);
  const [showClient, setShowClient] = useState(false);

  const queryInput = useMemo(
    () => ({
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      includeKnownTrackers: true,
    }),
    [page],
  );

  const query = useSuspenseQuery(
    trpc.searchees.candidates.queryOptions(queryInput),
  );
  const { data, isFetching } = query;

  useEffect(() => {
    if (page * PAGE_SIZE < data.total) return;
    if (data.total === 0) {
      setPage(0);
      return;
    }
    const newPage = Math.max(0, Math.ceil(data.total / PAGE_SIZE) - 1);
    if (newPage !== page) {
      setPage(newPage);
    }
  }, [data.total, page]);

  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  const canGoPrev = page > 0;
  const canGoNext = (page + 1) * PAGE_SIZE < data.total;
  const items = data.items;
  const rangeStart = data.total === 0 ? 0 : page * PAGE_SIZE + 1;
  const rangeEnd = data.total === 0 ? 0 : page * PAGE_SIZE + items.length;

  const formatTimestamp = (value: string | null) =>
    value ? formatRelativeTime(value) : 'Never';

  return (
    <Page>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Candidates</h1>
          <p className="text-muted-foreground text-sm">
            Showing {rangeStart}-{rangeEnd} of {data.total} items
          </p>
        </div>
        <div className="bg-muted/30 text-muted-foreground flex flex-col gap-2 rounded-lg border px-3 py-2 text-sm lg:flex-row lg:items-center lg:gap-4">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowClient((prev) => !prev)}
            >
              {showClient ? 'Hide torrent client' : 'Show torrent client'}
            </Button>
          </div>
          <div className="bg-border hidden h-4 w-px lg:block" />
          <div className="flex items-center gap-2 text-sm font-medium">
            <span>
              Page {Math.min(page + 1, totalPages)} of {totalPages}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                className="hidden h-7 w-7 p-0 lg:flex"
                onClick={() => setPage(0)}
                disabled={!canGoPrev || isFetching}
              >
                <span className="sr-only">Go to first page</span>
                <ChevronsLeft className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7"
                onClick={() => setPage((prev) => Math.max(0, prev - 1))}
                disabled={!canGoPrev || isFetching}
              >
                <span className="sr-only">Go to previous page</span>
                <ChevronLeft className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7"
                onClick={() => setPage((prev) => prev + 1)}
                disabled={!canGoNext || isFetching}
              >
                <span className="sr-only">Go to next page</span>
                <ChevronRight className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="hidden h-7 w-7 p-0 lg:flex"
                onClick={() => setPage(totalPages - 1)}
                disabled={!canGoNext || isFetching}
              >
                <span className="sr-only">Go to last page</span>
                <ChevronsRight className="size-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader className="bg-muted sticky top-0 z-10">
            <TableRow className="border-b">
              <TableHead>Name</TableHead>
              <TableHead>Info Hash</TableHead>
              <TableHead>Candidate Tracker</TableHead>
              <TableHead>Current Tracker</TableHead>
              <TableHead>First Seen</TableHead>
              <TableHead>Last Seen</TableHead>
              {showClient && <TableHead>Client</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={showClient ? 7 : 6}
                  className="py-10 text-center"
                >
                  <div className="flex flex-col items-center gap-2">
                    <span className="text-muted-foreground text-sm">
                      No candidates found.
                    </span>
                    <span className="text-muted-foreground text-xs">
                      Candidates appear when info hashes match across trackers.
                    </span>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="font-medium">{item.name}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {item.infoHash ?? 'Unknown'}
                  </TableCell>
                  <TableCell>
                    {item.candidateTrackers.length
                      ? item.candidateTrackers.join(', ')
                      : 'Unknown'}
                  </TableCell>
                  <TableCell>
                    {item.knownTrackers && item.knownTrackers.length
                      ? item.knownTrackers.join(', ')
                      : 'Unknown'}
                  </TableCell>
                  <TableCell>{formatTimestamp(item.firstSeenAt)}</TableCell>
                  <TableCell>{formatTimestamp(item.lastSeenAt)}</TableCell>
                  {showClient && (
                    <TableCell>
                      {item.clientDisplay && item.clientDisplay.length
                        ? item.clientDisplay.join(', ')
                        : 'Unknown'}
                    </TableCell>
                  )}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </Page>
  );
}
